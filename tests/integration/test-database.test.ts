import type { Database } from '../../src/index'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { afterAll, describe, expect, it } from 'bun:test'
import { testDatabase } from '../../src/index'
import { TEST_URL } from '../helpers/db'

const dirs: string[] = []
const prefix = `tdb_${crypto.randomUUID().slice(0, 6)}`
let count = 0

function serverUrl(name: string): string {
  const url = new URL(TEST_URL)

  url.pathname = `/${name}`

  return url.href
}

// A migrations folder of its own and an app database named apart, so each test builds its own template.
function project(migrations: Record<string, string>): { url: string, migrationsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pg-orm-testdb-'))

  dirs.push(dir)

  for (const [name, up] of Object.entries(migrations))
    writeFileSync(join(dir, `${name}.sql`), `-- migrate:up\n${up}\n\n-- migrate:down\nDROP TABLE member;\n`)

  return { url: serverUrl(`${prefix}_${count++}`), migrationsDir: dir }
}

async function databases(pattern: string): Promise<string[]> {
  const admin = new SQL(serverUrl('postgres'))

  try {
    return (await admin`SELECT datname FROM pg_database WHERE datname LIKE ${pattern} ORDER BY datname`).map((row: { datname: string }) => row.datname)
  }
  finally {
    await admin.close()
  }
}

async function names(url: string): Promise<string[]> {
  const sql = new SQL(url)

  try {
    return (await sql`SELECT name FROM member ORDER BY name`).map((row: { name: string }) => row.name)
  }
  finally {
    await sql.close()
  }
}

const MEMBER = 'CREATE TABLE member (id serial PRIMARY KEY, name text NOT NULL);'
const seedAda = async (db: Database) => void await db.raw('INSERT INTO member (name) VALUES ($1)', ['Ada'])

afterAll(async () => {
  const admin = new SQL(serverUrl('postgres'))

  try {
    for (const { datname } of await admin`SELECT datname FROM pg_database WHERE datname LIKE ${`${prefix}%`}`)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
  }
  finally {
    await admin.close()
  }

  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true })
})

describe('testDatabase', () => {
  it('gives each caller a copy of the migrated, seeded database, which no other copy sees writes to', async () => {
    const app = project({ '0001_member': MEMBER })
    const [first, second] = await Promise.all([testDatabase({ ...app, seed: seedAda }), testDatabase({ ...app, seed: seedAda })])

    try {
      expect(first.url).not.toBe(second.url)

      const sql = new SQL(first.url)

      await sql`INSERT INTO member (name) VALUES ('Grace')`
      await sql.close()

      expect(await names(first.url)).toEqual(['Ada', 'Grace'])
      expect(await names(second.url)).toEqual(['Ada'])
      // Racing to build it, the two left one template behind.
      expect(await databases(`${new URL(app.url).pathname.slice(1)}_tpl_%`)).toHaveLength(1)
    }
    finally {
      await Promise.all([first.drop(), second.drop()])
    }
  })

  it('records the files in the migration history, as pg-orm apply does', async () => {
    const app = project({ '0001_member': MEMBER, '0002_email': 'ALTER TABLE member ADD COLUMN email text;' })
    const database = await testDatabase(app)
    const sql = new SQL(database.url)

    try {
      expect((await sql`SELECT name FROM _pgorm_migrations ORDER BY id`).map((row: { name: string }) => row.name)).toEqual(['0001_member', '0002_email'])
      expect((await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'member' ORDER BY ordinal_position`).map((row: { column_name: string }) => row.column_name)).toEqual(['id', 'name', 'email'])
    }
    finally {
      await sql.close()
      await database.drop()
    }
  })

  it('builds the template again once a migration file or the seed changes, dropping the one it replaces, and reuses it otherwise', async () => {
    const app = project({ '0001_member': MEMBER })
    const base = new URL(app.url).pathname.slice(1)

    await (await testDatabase({ ...app, seed: seedAda })).drop()
    await (await testDatabase({ ...app, seed: seedAda })).drop()
    expect(await databases(`${base}_tpl_%`)).toHaveLength(1)

    writeFileSync(join(app.migrationsDir, '0002_email.sql'), '-- migrate:up\nALTER TABLE member ADD COLUMN email text;\n')
    await (await testDatabase({ ...app, seed: seedAda })).drop()
    await (await testDatabase({ ...app, seed: async db => void await db.raw('INSERT INTO member (name) VALUES ($1)', ['Grace']) })).drop()
    expect(await databases(`${base}_tpl_%`)).toHaveLength(1)
  })

  it('drops the copy though the app is still connected to it', async () => {
    const database = await testDatabase(project({ '0001_member': MEMBER }))
    const name = new URL(database.url).pathname.slice(1)
    const open = new SQL(database.url)

    await open`SELECT 1`
    await database.drop()
    expect(await databases(name)).toEqual([])
    // The server ended its session; Bun's client neither settles a close() nor fails a query after that, so it is left alone.
  })

  it('names a missing migrations folder', async () => {
    await expect(testDatabase({ url: serverUrl(`${prefix}_missing`), migrationsDir: join(tmpdir(), 'pg-orm-no-such-folder') })).rejects.toThrow('testDatabase: no migrations folder at')
  })

  it('copies a database whose name is longer than Postgres allows, under a name it accepts', async () => {
    const app = project({ '0001_member': MEMBER })
    const long = { ...app, url: serverUrl(`${prefix}_${'x'.repeat(80)}`) }
    const database = await testDatabase(long)

    try {
      expect(new URL(database.url).pathname.length - 1).toBeLessThanOrEqual(63)
      expect(await names(database.url)).toEqual([])
    }
    finally {
      await database.drop()
    }
  })

  it('leaves no half-built template behind when a migration fails', async () => {
    const app = project({ '0001_broken': 'CREATE TABLE member (id serial PRIMARY KEY, name nonsense);' })

    await expect(testDatabase(app)).rejects.toThrow('nonsense')
    expect(await databases(`${new URL(app.url).pathname.slice(1)}%`)).toEqual([])
  })
})
