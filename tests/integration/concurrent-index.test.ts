import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { applyMigration, Database, defineTable, generateMigration, MigrationError } from '../../src/index'
import { applyMigrationFiles } from '../../src/migration/files'
import { createTestDb } from '../helpers/db'

const plain = defineTable('ci_events', t => ({
  id: t.serial().primaryKey(),
  kind: t.text(),
}))

const indexed = defineTable('ci_events', t => ({
  id: t.serial().primaryKey(),
  kind: t.text().index({ concurrently: true }),
}))

const unique = defineTable('ci_events', t => ({
  id: t.serial().primaryKey(),
  kind: t.text(),
})).withIndexes([{ columns: ['kind'], unique: true, name: 'ci_events_kind_key', concurrently: true }])

const open: Database[] = []

function dbFor(table: typeof plain) {
  const db = createTestDb({ tables: [table] })

  open.push(db)

  return db
}

async function indexState(db: Database, name: string): Promise<boolean | null> {
  const [row] = await db.raw<{ valid: boolean }>('SELECT ix.indisvalid AS valid FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid WHERE i.relname = $1', [name])

  return row?.valid ?? null
}

describe('CREATE INDEX CONCURRENTLY on Postgres', () => {
  const base = dbFor(plain)

  beforeEach(async () => {
    await base.raw('DROP TABLE IF EXISTS "ci_events"')
    await base.sync({ allowDestructive: true })
    await base.repo(plain).write.insertMany([{ kind: 'a' }, { kind: 'b' }, { kind: 'a' }])
  })

  afterAll(async () => {
    await base.raw('DROP TABLE IF EXISTS "ci_events"')
    for (const db of open) await db.close()
  })

  it('sync builds it on an existing table after its transaction, and a second sync finds nothing to do', async () => {
    const db = dbFor(indexed)
    const { ops } = await db.sync({ allowDestructive: true })

    expect(ops.filter(o => o.outsideTransaction).map(o => o.sql)).toEqual(['CREATE INDEX CONCURRENTLY IF NOT EXISTS "ci_events_kind_idx" ON "ci_events" USING btree ("kind")'])
    expect(await indexState(db, 'ci_events_kind_idx')).toBe(true)
    expect((await db.sync({ allowDestructive: true })).ops).toEqual([])
  })

  it('reports a failed build, and the next sync drops the invalid index and builds it again', async () => {
    const db = dbFor(unique)

    await expect(db.sync()).rejects.toThrow(MigrationError)
    expect(await indexState(db, 'ci_events_kind_key')).toBe(false)

    await db.raw('DELETE FROM "ci_events" WHERE "id" = (SELECT max("id") FROM "ci_events" WHERE "kind" = $1)', ['a'])

    const { ops } = await db.sync()

    expect(ops.map(o => o.description)).toEqual(['Drop index "ci_events_kind_key" from "ci_events" (invalid)', 'Recreate index "ci_events_kind_key" on "ci_events" (kind)'])
    expect(await indexState(db, 'ci_events_kind_key')).toBe(true)
  })

  it('a generated migration applies, its concurrent statement run outside the transaction', async () => {
    const db = dbFor(indexed)
    const file = await generateMigration(db, db.getTablesRegistry())

    expect(file?.up).toContain('CREATE INDEX CONCURRENTLY')

    await applyMigration(db, file!.up)

    expect(await indexState(db, 'ci_events_kind_idx')).toBe(true)
  })

  it('a migration file applies and is recorded, its concurrent statement run after its transaction', async () => {
    const db = dbFor(indexed)
    const file = await generateMigration(db, db.getTablesRegistry())
    const dir = mkdtempSync(join(tmpdir(), 'pg-orm-ci-'))

    try {
      writeFileSync(join(dir, `${file!.name}.sql`), `-- migrate:up\n${file!.up}\n-- migrate:down\n${file!.down}`)

      expect(await applyMigrationFiles(db, dir)).toEqual([`${file!.name}.sql`])
      expect(await indexState(db, 'ci_events_kind_idx')).toBe(true)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
      await db.raw('DELETE FROM "_pgorm_migrations" WHERE "name" = $1', [file!.name])
    }
  })
})

describe('an index marked concurrently on SQLite', () => {
  it('is built as a plain index, in the migration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-orm-ci-sqlite-'))
    const db = new Database({ url: `sqlite://${join(dir, 'ci.db')}`, tables: [plain] })

    try {
      await db.sync()

      const grown = new Database({ url: `sqlite://${join(dir, 'ci.db')}`, tables: [indexed] })
      const { ops } = await grown.sync()

      expect(ops.map(o => o.sql)).toEqual(['CREATE INDEX "ci_events_kind_idx" ON "ci_events" ("kind")'])
      await grown.close()
    }
    finally {
      await db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
