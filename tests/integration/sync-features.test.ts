import { describe, expect, it } from 'bun:test'
import { defineTable, UniqueError } from '../../src/index'
import { syncSchemaHarness } from '../helpers/schema-sync'

const SCHEMA = 'pgorm_sync_features'
const { admin, at, sync, constraints } = syncSchemaHarness(SCHEMA)

const q = (table: string) => `"${SCHEMA}"."${table}"`

describe('sync() and the schema features', () => {
  it('creates timestamp and time precision and defaultNow(), then finds nothing to do', async () => {
    const table = defineTable('stamps', t => ({ id: t.serial().primaryKey(), at: t.timestamptz(3).defaultNow(), local: t.timestamp(0).nullable(), clock: t.time(2).nullable() }))

    await sync([table])

    expect(await admin.raw(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, pg_get_expr(d.adbin, d.adrelid) AS "default"
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = '${q('stamps')}'::regclass AND a.attname IN ('at', 'local', 'clock') ORDER BY a.attnum`)).toEqual([
      { name: 'at', type: 'timestamp(3) with time zone', default: 'now()' },
      { name: 'local', type: 'timestamp(0) without time zone', default: null },
      { name: 'clock', type: 'time(2) without time zone', default: null },
    ])
    expect((await sync([table])).ops).toEqual([])
  })

  it('turns a serial key into an identity numbering on from the rows there, then makes it always generated', async () => {
    await sync([defineTable('ids', t => ({ id: t.serial().primaryKey(), n: t.text() }))])
    await admin.raw(`INSERT INTO ${q('ids')} ("n") VALUES ('a'), ('b')`)

    const byDefault = defineTable('ids', t => ({ id: t.int4().primaryKey().identity(), n: t.text() }))

    await sync([byDefault])

    expect(await admin.raw(`INSERT INTO ${q('ids')} ("n") VALUES ('c') RETURNING "id"`)).toEqual([{ id: 3 }])
    expect((await sync([byDefault])).ops).toEqual([])

    const always = defineTable('ids', t => ({ id: t.int4().primaryKey().identity({ always: true }), n: t.text() }))

    await sync([always])

    await expect(admin.raw(`INSERT INTO ${q('ids')} ("id", "n") VALUES (10, 'd')`)).rejects.toThrow()
    expect((await sync([always])).ops).toEqual([])

    const fresh = defineTable('fresh_ids', t => ({ id: t.int8().primaryKey().identity(), n: t.text() }))

    await sync([always, fresh])
    expect((await sync([always, fresh])).ops).toEqual([])
  })

  it('adds, keeps and drops a UNIQUE over several columns', async () => {
    const base = () => defineTable('pairs', t => ({ id: t.serial().primaryKey(), a: t.int4(), b: t.int4() }))

    await sync([base()])

    const unique = base().withUnique(['a', 'b'])

    await sync([unique])

    expect(await constraints('pairs', 'u')).toEqual([{ name: 'pairs_a_b_key', columns: ['a', 'b'] }])
    await admin.raw(`INSERT INTO ${q('pairs')} ("a", "b") VALUES (1, 1), (1, 2)`)
    await expect(admin.raw(`INSERT INTO ${q('pairs')} ("a", "b") VALUES (1, 1)`)).rejects.toBeInstanceOf(UniqueError)
    expect((await sync([unique])).ops).toEqual([])

    await sync([base()], true)

    expect(await constraints('pairs', 'u')).toEqual([])

    const created = defineTable('trios', t => ({ id: t.serial().primaryKey(), a: t.int4(), b: t.int4() })).withUnique(['b', 'a'], 'trios_ba')

    await sync([base(), created])

    expect(await constraints('trios', 'u')).toEqual([{ name: 'trios_ba', columns: ['a', 'b'] }])
    expect((await sync([base(), created])).ops).toEqual([])
  })

  it('creates expression, descending, operator class and covering indexes that the next sync leaves alone', async () => {
    const docs = (desc: string[]) => defineTable('docs', t => ({ id: t.serial().primaryKey(), title: t.text(), created: t.timestamptz() })).withIndexes([
      { name: 'docs_lower_title', columns: [], expressions: ['lower(title)'] },
      { columns: ['created'], desc, include: ['title'] },
      { columns: ['title'], opclass: { title: 'text_pattern_ops' }, unique: true },
    ])

    await sync([docs(['created'])])

    const definitions = await admin.raw<{ def: string }>(`SELECT indexdef AS def FROM pg_indexes WHERE schemaname = '${SCHEMA}' AND tablename = 'docs' AND indexname <> 'docs_pkey' ORDER BY indexname`)

    expect(definitions.map(d => d.def.slice(d.def.indexOf(' USING ')))).toEqual([
      ' USING btree (created DESC) INCLUDE (title)',
      ' USING btree (lower(title))',
      ' USING btree (title text_pattern_ops)',
    ])
    expect((await sync([docs(['created'])])).ops).toEqual([])
    expect((await sync([docs([])], true)).ops.map(op => op.type)).toEqual(['drop_index', 'create_index'])
    expect((await sync([docs([])])).ops).toEqual([])
  })

  it('renames a table with its rows, the foreign key pointing at it and its index', async () => {
    const before = defineTable('old_items', t => ({ id: t.serial().primaryKey(), label: t.text().index() }))
    const childBefore = defineTable('children', t => ({ id: t.serial().primaryKey(), item_id: t.int4().references(() => before, 'id') }))

    await sync([before, childBefore])
    await admin.raw(`INSERT INTO ${q('old_items')} ("label") VALUES ('kept')`)
    await admin.raw(`INSERT INTO ${q('children')} ("item_id") VALUES (1)`)

    const after = defineTable('items', t => ({ id: t.serial().primaryKey(), label: t.text().index() })).renamedFrom('old_items')
    const childAfter = defineTable('children', t => ({ id: t.serial().primaryKey(), item_id: t.int4().references(() => after, 'id') }))
    const { ops } = await sync([after, childAfter])

    expect(ops.map(op => op.type)).toEqual(['rename_table', 'rename_index'])
    expect(await admin.raw(`SELECT "label" FROM ${q('items')}`)).toEqual([{ label: 'kept' }])
    expect(await admin.raw(`SELECT indexname AS name FROM pg_indexes WHERE schemaname = '${SCHEMA}' AND tablename = 'items' ORDER BY indexname`)).toEqual([{ name: 'items_label_idx' }, { name: 'old_items_pkey' }])
    expect((await sync([after, childAfter])).ops).toEqual([])
  })

  it('rebuilds a partial index and a generated column whose string literal changed, and only then', async () => {
    const tasks = (state: string) => defineTable('tasks', t => ({
      id: t.serial().primaryKey(),
      state: t.text().index({ where: `"state" = '${state}'` }),
      label: t.text().generated(`'${state}: ' || "state"`),
    }))

    await sync([tasks('Active')])
    expect((await sync([tasks('Active')])).ops).toEqual([])

    const { ops } = await sync([tasks('active')], true)

    expect(ops.map(op => op.type).sort()).toEqual(['alter_column', 'create_index', 'drop_index'])
    expect((await sync([tasks('active')])).ops).toEqual([])
  })

  it('renames a table with its composite UNIQUE, keeping one, and a rollback names it back', async () => {
    const before = defineTable('old_pairs', t => ({ id: t.serial().primaryKey(), a: t.int4(), b: t.int4() })).withUnique(['a', 'b'])
    const after = defineTable('pairs', t => ({ id: t.serial().primaryKey(), a: t.int4(), b: t.int4() })).withUnique(['a', 'b']).renamedFrom('old_pairs')
    const uniques = () => admin.raw(`SELECT conname AS name FROM pg_constraint WHERE contype = 'u' AND connamespace = '${SCHEMA}'::regnamespace ORDER BY conname`)

    await sync([before])

    const { ops } = await sync([after])

    expect(ops.map(op => op.type)).toEqual(['rename_table', 'rename_constraint'])
    expect(await uniques()).toEqual([{ name: 'pairs_a_b_key' }])
    expect((await sync([after])).ops).toEqual([])

    await at([after], db => db.rollback())
    expect(await uniques()).toEqual([{ name: 'old_pairs_a_b_key' }])
  })

  it('sets table and column comments, and a rollback puts the previous ones back', async () => {
    const v1 = defineTable('notes', t => ({ id: t.serial().primaryKey(), body: t.text().comment('The text') })).withComment('Notes')

    await sync([v1])

    const comments = () => admin.raw(`SELECT obj_description('${q('notes')}'::regclass, 'pg_class') AS "table", col_description('${q('notes')}'::regclass, 2) AS "column"`)

    expect(await comments()).toEqual([{ table: 'Notes', column: 'The text' }])
    expect((await sync([v1])).ops).toEqual([])

    const v2 = defineTable('notes', t => ({ id: t.serial().primaryKey(), body: t.text().comment('It\'s the text') }))

    await sync([v2])

    expect(await comments()).toEqual([{ table: null, column: 'It\'s the text' }])
    await at([v2], db => db.rollback())
    expect(await comments()).toEqual([{ table: 'Notes', column: 'The text' }])
  })

  it('creates a deferrable foreign key, checked at commit', async () => {
    const parents = defineTable('parents', t => ({ id: t.int4().primaryKey() }))
    const kids = defineTable('kids', t => ({ id: t.serial().primaryKey(), parent_id: t.int4().references(() => parents, 'id', { deferrable: 'deferred' }) }))

    await sync([parents, kids])

    expect((await sync([parents, kids])).ops).toEqual([])
    await admin.transaction(async (tx) => {
      await tx.query(`INSERT INTO ${q('kids')} ("parent_id") VALUES (7)`, [])
      await tx.query(`INSERT INTO ${q('parents')} ("id") VALUES (7)`, [])
    })
    expect(await admin.raw(`SELECT count(*)::int AS n FROM ${q('kids')}`)).toEqual([{ n: 1 }])

    const immediate = defineTable('kids', t => ({ id: t.serial().primaryKey(), parent_id: t.int4().references(() => parents, 'id') }))

    expect((await sync([parents, immediate])).ops.map(op => op.type)).toEqual(['drop_fk', 'add_fk'])
  })
})
