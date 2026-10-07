import type { AnyTableDef } from '../types/index'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SQL } from 'bun'
import { applyMigrationFiles } from '../migration/files'
import { Database } from '../sql/database'

export interface TestDatabaseOptions {
  /** The database the app reads in tests, `DATABASE_URL` in `.env.test`: its server holds the copies, each named after it. It need not exist. */
  url: string
  /** The migration files every copy starts from, applied as `pg-orm apply` applies them. */
  migrationsDir: string
  /** Fills the database once its schema is in, before any copy is made: what every test starts with. */
  seed?: (db: Database) => Promise<void> | void
  /** The tables `seed` reaches through `db.repo(table)`. */
  tables?: AnyTableDef[]
}

export interface TestDatabase {
  /** The copy's connection string: the app's `DATABASE_URL` while the test runs. */
  url: string
  /** Drops the copy, closing what is still connected to it. */
  drop: () => Promise<void>
}

const NOT_IDENTIFIER = /\W+/g
// Postgres cuts identifiers at 63 bytes, so the name copies are made under leaves room for what follows it.
const MAX_BASE = 40
// Losing the race to the name: 42P04 when the name was taken before the rename started, 23505 on the catalog's unique index when both ran at once.
const DUPLICATE_DATABASE = new Set(['42P04', '23505'])
const TEMPLATE_HASH = /^[a-z0-9]+$/

function quote(name: string): string {
  return `"${name}"`
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url)

  parsed.pathname = `/${name}`

  return parsed.href
}

function randomSuffix(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 10)
}

// The template's name changes with every migration file and with the seed, so an edit to either builds a new one rather than reusing one that no longer matches.
function templateName(base: string, options: TestDatabaseOptions): string {
  const files = readdirSync(options.migrationsDir).filter(file => file.endsWith('.sql')).sort()
  const content = files.map(file => `${file}\n${readFileSync(join(options.migrationsDir, file), 'utf8')}`).join('\n')
  const hash = Bun.hash(`${content}\n${options.seed?.toString() ?? ''}`).toString(36).slice(0, 10)

  return `${base}_tpl_${hash}`
}

async function exists(admin: SQL, name: string): Promise<boolean> {
  return (await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`).length > 0
}

// The templates earlier migration files or seeds left, once a new one is in place. One a run still copies from refuses to go, and stays for the next build.
async function dropStaleTemplates(admin: SQL, base: string, keep: string): Promise<void> {
  const prefix = `${base}_tpl_`

  for (const { datname } of await admin`SELECT datname FROM pg_database WHERE starts_with(datname, ${prefix})` as { datname: string }[]) {
    // A template being built carries a suffix after its hash, and is another run's.
    if (datname === keep || !TEMPLATE_HASH.test(datname.slice(prefix.length)))
      continue

    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(datname)}`)
    }
    catch {}
  }
}

// Migrated and seeded under a name of its own, then renamed: a run racing another sees the template whole or not at all, and the loser drops its copy.
async function buildTemplate(admin: SQL, url: string, base: string, name: string, options: TestDatabaseOptions): Promise<void> {
  const building = `${name}_${randomSuffix()}`

  await admin.unsafe(`CREATE DATABASE ${quote(building)}`)

  try {
    const db = new Database({ url: withDatabase(url, building), tables: options.tables })

    try {
      await applyMigrationFiles(db, options.migrationsDir)
      await options.seed?.(db)
    }
    finally {
      await db.close()
    }

    await admin.unsafe(`ALTER DATABASE ${quote(building)} RENAME TO ${quote(name)}`)
  }
  catch (error) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(building)} WITH (FORCE)`)

    if (!DUPLICATE_DATABASE.has((error as { errno?: string }).errno ?? ''))
      throw error

    return
  }

  await dropStaleTemplates(admin, base, name)
}

/**
 * A database of its own for a test file: a copy of one migrated from `migrationsDir` and seeded once, which later calls copy in milliseconds while the files and the seed stay the same.
 * Drop it when the file is done; the copies of a run that crashed are left on the test server, named `<database>_t<suffix>`.
 * @example
 * ```ts
 * const database = await testDatabase({ url: process.env.DATABASE_URL!, migrationsDir: 'migrations', seed: async db => void await db.repo(User).write.insertOne({ name: 'Ada' }) })
 * process.env.DATABASE_URL = database.url
 * afterAll(() => database.drop())
 * ```
 */
export async function testDatabase(options: TestDatabaseOptions): Promise<TestDatabase> {
  const base = new URL(options.url).pathname.slice(1).replace(NOT_IDENTIFIER, '_').slice(0, MAX_BASE) || 'test'
  // CREATE DATABASE runs from another database of the server, which always has `postgres`.
  const admin = new SQL(withDatabase(options.url, 'postgres'))
  const template = templateName(base, options)
  const name = `${base}_t${randomSuffix()}`

  try {
    if (!await exists(admin, template))
      await buildTemplate(admin, options.url, base, template, options)

    await admin.unsafe(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(template)}`)
  }
  finally {
    await admin.close()
  }

  return {
    url: withDatabase(options.url, name),
    drop: async () => {
      const dropping = new SQL(withDatabase(options.url, 'postgres'))

      try {
        await dropping.unsafe(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`)
      }
      finally {
        await dropping.close()
      }
    },
  }
}
