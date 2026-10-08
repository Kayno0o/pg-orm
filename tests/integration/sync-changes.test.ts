import { describe, expect, it } from 'bun:test'
import { defineTable, DestructiveOpError, UniqueError } from '../../src/index'
import { syncSchemaHarness } from '../helpers/schema-sync'

const SCHEMA = 'pgorm_sync_changes'
const { admin, at, sync, constraints } = syncSchemaHarness(SCHEMA)

describe('sync() applies every change in one go', () => {
  it('adds a new unique column with its UNIQUE constraint', async () => {
    await sync([defineTable('things', t => ({ id: t.serial().primaryKey() }))])

    const v2 = defineTable('things', t => ({ id: t.serial().primaryKey(), code: t.text().nullable().unique() }))

    await sync([v2])

    expect(await constraints('things', 'u')).toEqual([{ name: 'things_code_key', columns: ['code'] }])
    expect((await sync([v2])).ops).toEqual([])
    await admin.raw(`INSERT INTO "${SCHEMA}"."things" ("code") VALUES ('a')`)
    await expect(admin.raw(`INSERT INTO "${SCHEMA}"."things" ("code") VALUES ('a')`)).rejects.toBeInstanceOf(UniqueError)
  })

  it('adds a primary key, and moves one only when destructive ops are allowed', async () => {
    await sync([defineTable('pairs', t => ({ a: t.int4(), b: t.int4() }))])
    await admin.raw(`INSERT INTO "${SCHEMA}"."pairs" ("a", "b") VALUES (1, 10), (2, 10)`)

    const onA = defineTable('pairs', t => ({ a: t.int4().primaryKey(), b: t.int4() }))

    await sync([onA])

    expect(await constraints('pairs', 'p')).toEqual([{ name: 'pairs_pkey', columns: ['a'] }])
    expect((await sync([onA])).ops).toEqual([])

    const onAb = defineTable('pairs', t => ({ a: t.int4().primaryKey(), b: t.int4().primaryKey() }))

    await expect(sync([onAb])).rejects.toBeInstanceOf(DestructiveOpError)
    await sync([onAb], true)

    expect(await constraints('pairs', 'p')).toEqual([{ name: 'pairs_pkey', columns: ['a', 'b'] }])
    expect((await sync([onAb])).ops).toEqual([])
  })

  it('changes a generated expression, turns a generated column plain and a plain one generated', async () => {
    const sum = defineTable('calc', t => ({ id: t.serial().primaryKey(), a: t.int4(), b: t.int4(), total: t.int4().generated('a + b') }))

    await sync([sum])
    await admin.raw(`INSERT INTO "${SCHEMA}"."calc" ("a", "b") VALUES (2, 3)`)
    expect((await sync([sum])).ops).toEqual([])

    const product = defineTable('calc', t => ({ id: t.serial().primaryKey(), a: t.int4(), b: t.int4(), total: t.int4().generated('"a" * "b"') }))

    await sync([product])

    expect(await admin.raw(`SELECT "total" FROM "${SCHEMA}"."calc"`)).toEqual([{ total: 6 }])
    expect((await sync([product])).ops).toEqual([])

    const plain = defineTable('calc', t => ({ id: t.serial().primaryKey(), a: t.int4(), b: t.int4(), total: t.int4().nullable() }))

    await sync([plain])
    await admin.raw(`UPDATE "${SCHEMA}"."calc" SET "a" = 4`)

    expect(await admin.raw(`SELECT "total" FROM "${SCHEMA}"."calc"`)).toEqual([{ total: 6 }])
    expect((await sync([plain])).ops).toEqual([])

    await expect(sync([sum])).rejects.toBeInstanceOf(DestructiveOpError)
    await sync([sum], true)

    expect(await admin.raw(`SELECT "total" FROM "${SCHEMA}"."calc"`)).toEqual([{ total: 7 }])
    expect((await sync([sum])).ops).toEqual([])
  })

  it('adds a NOT NULL column to a table with rows through its backfill value, leaving it no default', async () => {
    await sync([defineTable('notes', t => ({ id: t.serial().primaryKey() }))])
    await admin.raw(`INSERT INTO "${SCHEMA}"."notes" DEFAULT VALUES`)

    const unfilled = defineTable('notes', t => ({ id: t.serial().primaryKey(), label: t.text() }))
    const preview = await at([unfilled], db => db.sync({ dryRun: true }))

    expect(preview.ops.map(op => op.description)).toEqual([expect.stringContaining('fails if the table has rows')])

    const filled = defineTable('notes', t => ({ id: t.serial().primaryKey(), label: t.text().backfill('none') }))

    await sync([filled])

    expect(await admin.raw(`SELECT "label" FROM "${SCHEMA}"."notes"`)).toEqual([{ label: 'none' }])
    expect(await admin.raw(`SELECT column_default AS "default", is_nullable AS "nullable" FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND table_name = 'notes' AND column_name = 'label'`)).toEqual([{ default: null, nullable: 'NO' }])
    expect((await sync([filled])).ops).toEqual([])
  })

  it('keeps one foreign key and the unique constraint through a column rename', async () => {
    const parents = defineTable('parents', t => ({ id: t.serial().primaryKey() }))
    const v1 = defineTable('children', t => ({
      id: t.serial().primaryKey(),
      parent_id: t.int4().references(() => parents, 'id'),
      code: t.text().unique(),
    }))

    await sync([parents, v1])

    const v2 = defineTable('children', t => ({
      id: t.serial().primaryKey(),
      owner_id: t.int4().renamedFrom('parent_id').references(() => parents, 'id'),
      ref: t.text().renamedFrom('code').unique(),
    }))

    await sync([parents, v2])

    expect(await constraints('children', 'f')).toEqual([{ name: 'children_parent_id_fkey', columns: ['owner_id'] }])
    expect((await sync([parents, v2])).ops).toEqual([])

    const v3 = defineTable('children', t => ({ id: t.serial().primaryKey(), owner_id: t.int4(), ref: t.text() }))

    await sync([parents, v3], true)

    expect(await constraints('children', 'f')).toEqual([])
    expect(await constraints('children', 'u')).toEqual([])
  })
})
