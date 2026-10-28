import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { TEST_URL } from '../helpers/db'
import { syncSchemaHarness } from '../helpers/schema-sync'

const SCHEMA = 'pgorm_cli'
const { admin } = syncSchemaHarness(SCHEMA)
const SRC = resolve(import.meta.dir, '../../src')
const CLI = join(SRC, 'cli.ts')
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true })
})

// A project whose config picks the table version the VERSION env var names, and leaves the "legacy" table alone.
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pg-orm-cli-'))

  dirs.push(dir)
  writeFileSync(join(dir, 'pg-orm.config.ts'), `
import { Database, defineTable } from ${JSON.stringify(join(SRC, 'index.ts'))}

const versions = {
  1: defineTable('notes', t => ({ id: t.serial().primaryKey(), title: t.text(), body: t.text() })),
  2: defineTable('notes', t => ({ id: t.serial().primaryKey(), title: t.text() })),
  3: defineTable('notes', t => ({ id: t.serial().primaryKey(), title: t.text(), owner: t.text() })),
}

export default {
  db: new Database({ url: ${JSON.stringify(TEST_URL)}, schema: ${JSON.stringify(SCHEMA)}, tables: [versions[process.env.VERSION ?? '1']] }),
  migrationsDir: 'migrations',
  ignoreTables: ['legacy'],
}
`)

  return dir
}

async function cli(dir: string, args: string[], version = '1'): Promise<{ code: number, out: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], { cwd: dir, env: { ...process.env, VERSION: version }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])

  return { code, out: out + err }
}

function files(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'migrations'))
  }
  catch {
    return []
  }
}

async function ups(): Promise<string[]> {
  const rows = await admin.raw<{ name: string }>(`SELECT name FROM "${SCHEMA}"."_pgorm_migrations" WHERE direction = 'up' ORDER BY id`)

  return rows.map(r => r.name)
}

async function columns(): Promise<string[]> {
  const rows = await admin.raw<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND table_name = 'notes' ORDER BY ordinal_position`)

  return rows.map(r => r.name)
}

describe('pg-orm CLI', () => {
  it('syncs, previews with --dry-run, refuses a destructive change unless --allow-destructive, and leaves ignored tables alone', async () => {
    const dir = project()

    await admin.raw(`CREATE TABLE "${SCHEMA}"."legacy" ("id" int)`)
    expect((await cli(dir, ['sync'])).code).toBe(0)
    expect(files(dir)).toHaveLength(1)

    const preview = await cli(dir, ['sync', '--dry-run'], '2')

    expect(preview.code).toBe(0)
    expect(preview.out).toContain('-- Drop column "body" from "notes"\nALTER TABLE "notes" DROP COLUMN "body";')
    expect(files(dir)).toHaveLength(1)

    const refused = await cli(dir, ['sync'], '2')

    expect(refused.code).toBe(1)
    expect(refused.out).toContain('DestructiveOpError')
    expect(files(dir)).toHaveLength(1)

    expect((await cli(dir, ['sync', '--allow-destructive'], '2')).code).toBe(0)
    expect(files(dir)).toHaveLength(2)
    expect(await columns()).toEqual(['id', 'title'])
    expect(await admin.raw(`SELECT to_regclass('"${SCHEMA}"."legacy"')::text AS found`)).toEqual([{ found: `${SCHEMA}.legacy` }])
    expect((await cli(dir, ['status'], '2')).out).toContain('Schema: no drift')

    const rollback = await cli(dir, ['rollback', '--dry-run'], '2')

    expect(rollback.code).toBe(1)
    expect(rollback.out).toContain('--dry-run does nothing for rollback')
    expect(await columns()).toEqual(['id', 'title'])
  })

  it('writes no file and records nothing when the apply fails', async () => {
    const dir = project()

    await cli(dir, ['sync'])
    await admin.raw(`INSERT INTO "${SCHEMA}"."notes" ("title", "body") VALUES ('a', 'b')`)

    // A NOT NULL column without a default cannot be added to a table with rows.
    const failed = await cli(dir, ['sync'], '3')

    expect(failed.code).toBe(1)
    expect(files(dir)).toHaveLength(1)
    expect(await ups()).toHaveLength(1)
    expect(await columns()).toEqual(['id', 'title', 'body'])
  })

  it('redacts the value a failing migration\'s error quotes, unless --raw', async () => {
    const dir = project()

    await cli(dir, ['sync'])
    writeFileSync(join(dir, 'migrations', '99999999999999_bad.sql'), '-- migrate:up\nSELECT \'cli-secret\'::int;\n\n-- migrate:down\n')

    const redacted = await cli(dir, ['apply'])
    const raw = await cli(dir, ['apply', '--raw'])

    expect(redacted.code).toBe(1)
    expect(redacted.out).not.toContain('cli-secret')
    expect(raw.code).toBe(1)
    expect(raw.out).toContain('cli-secret')
  })

  it('refuses to generate or sync while a file is not applied, naming it', async () => {
    const dir = project()

    await cli(dir, ['generate'])

    const [pending] = files(dir)

    for (const command of ['generate', 'sync']) {
      const refused = await cli(dir, [command], '3')

      expect(refused.code).toBe(1)
      expect(refused.out).toContain(`MigrationError: 1 migration file(s) not applied yet: ${pending}. Run \`pg-orm apply\` before \`pg-orm ${command}\`.`)
    }

    expect(files(dir)).toEqual([pending!])

    await cli(dir, ['apply'])
    expect((await cli(dir, ['generate', '--allow-destructive'], '3')).code).toBe(0)

    const added = readFileSync(join(dir, 'migrations', files(dir).find(f => f !== pending)!), 'utf8')

    expect(added).toContain('ADD COLUMN "owner"')
    expect(added).not.toContain('CREATE TABLE')
  })

  it('applies each file once and atomically, however many processes apply at the same time', async () => {
    const dir = project()

    await cli(dir, ['generate'])

    const [generated] = files(dir)
    const migrations = join(dir, 'migrations')

    writeFileSync(join(migrations, '9999_broken.sql'), '-- migrate:up\nCREATE TABLE "half" ("id" int);\nSELECT 1 / 0;\n\n-- migrate:down\nDROP TABLE "half";\n')

    const results = await Promise.all([cli(dir, ['apply']), cli(dir, ['apply']), cli(dir, ['apply'])])

    expect(results.every(r => r.code === 1)).toBe(true)
    expect(await ups()).toEqual([generated!.replace('.sql', '')])
    expect(await admin.raw(`SELECT to_regclass('"${SCHEMA}"."half"')::text AS found`)).toEqual([{ found: null }])
    expect(readFileSync(join(migrations, generated!), 'utf8')).toContain('-- Create table "notes"\nCREATE TABLE "notes"')
  })
})
