import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
import { syncSchemaHarness } from '../helpers/schema-sync'

const SCHEMA = 'pgorm_sync_regress'
const { admin, sync } = syncSchemaHarness(SCHEMA)

const q = (table: string) => `"${SCHEMA}"."${table}"`

describe('serial columns', () => {
  it('widens a serial to a bigserial, its sequence included, and then finds nothing', async () => {
    await sync([defineTable('sb', t => ({ id: t.serial().primaryKey() }))])

    const v2 = defineTable('sb', t => ({ id: t.bigserial().primaryKey() }))

    await sync([v2], true)

    expect(await admin.raw(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = '${q('sb')}'::regclass AND attname = 'id'`)).toEqual([{ type: 'bigint' }])
    expect(await admin.raw(`SELECT seqtypid::regtype::text AS type FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('${q('sb')}', 'id')::regclass`)).toEqual([{ type: 'bigint' }])
    expect((await sync([v2])).ops).toEqual([])
  })

  it('gives an int4 turned serial a sequence and a default', async () => {
    await sync([defineTable('si', t => ({ id: t.int4().primaryKey(), n: t.int4().nullable() }))])
    await admin.raw(`INSERT INTO ${q('si')} (id) VALUES (7)`)

    const v2 = defineTable('si', t => ({ id: t.serial().primaryKey(), n: t.int4().nullable() }))

    await sync([v2], true)

    expect((await sync([v2])).ops).toEqual([])
    expect(await admin.raw(`INSERT INTO ${q('si')} DEFAULT VALUES RETURNING id`)).toEqual([{ id: 8 }])
  })
})

describe('json defaults', () => {
  it('creates json and jsonb columns defaulting to an array, a string or a number, and then finds nothing', async () => {
    const table = defineTable('jd', t => ({
      id: t.serial().primaryKey(),
      list: t.jsonb<number[]>().default([1, 2]),
      empty: t.json<string[]>().default([]),
      word: t.jsonb<string>().default('plain'),
      quoted: t.json<string>().default('it\'s "x"'),
      count: t.jsonb<number>().default(3),
      flag: t.jsonb<boolean>().default(true),
      obj: t.jsonb<{ b: number, a: number }>().default({ b: 1, a: 2 }),
    }))

    await sync([table])
    await admin.raw(`INSERT INTO ${q('jd')} DEFAULT VALUES`)

    expect(await admin.raw(`SELECT list, "empty", word, quoted, count, flag, obj FROM ${q('jd')}`)).toEqual([{ list: [1, 2], empty: [], word: 'plain', quoted: 'it\'s "x"', count: 3, flag: true, obj: { a: 2, b: 1 } }])
    expect((await sync([table])).ops).toEqual([])
  })
})

describe('defaults Postgres respells', () => {
  it('finds nothing to change once a default is created, however Postgres prints it back', async () => {
    const table = defineTable('respelled', t => ({
      id: t.serial().primaryKey(),
      at: t.time().default('09:00'),
      zoned: t.timetz().default('09:00+02'),
      span: t.interval().default('1 hour'),
      span2: t.interval().default('1 year 2 mons 3 days 04:05:06'),
      addr: t.inet().default('10.0.0.1/32'),
      mac: t.macaddr().default('08-00-2b-01-02-03'),
      cash: t.money().default('1.5'),
      ref: t.uuid().default('A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'),
      big: t.float8().default(1e21),
      due: t.timestamptz().defaultRaw('now() + interval \'1 day\''),
    }))

    await sync([table])

    expect((await sync([table])).ops.map(o => o.sql)).toEqual([])
  })

  it('syncs a default changed to another value of the same type', async () => {
    const v1 = defineTable('respelled2', t => ({ id: t.serial().primaryKey(), at: t.time().default('09:00'), mac: t.macaddr().default('08:00:2b:01:02:03'), span: t.interval().default('1 hour') }))
    const v2 = defineTable('respelled2', t => ({ id: t.serial().primaryKey(), at: t.time().default('09:30'), mac: t.macaddr().default('08:00:2b:01:02:04'), span: t.interval().default('2 hours') }))

    await sync([v1])

    expect((await sync([v2])).ops).toHaveLength(3)
    expect((await sync([v2])).ops).toEqual([])
  })
})

describe('indexes', () => {
  it('syncs an index naming its default operator class once, and still sees another one', async () => {
    const make = (opclass: string) => defineTable('ops', t => ({ id: t.serial().primaryKey(), a_text: t.text() })).withIndexes([{ columns: ['a_text'], name: 'ops_a_text_idx', opclass: { a_text: opclass } }])
    const v1 = make('text_ops')

    await sync([v1])

    expect((await sync([v1])).ops).toEqual([])

    const v2 = make('text_pattern_ops')

    expect((await sync([v2], true)).ops.map(o => o.type)).toEqual(['drop_index', 'create_index'])
    expect((await sync([v2])).ops).toEqual([])
  })
})

describe('expressions that differ only in grouping', () => {
  const grouped = (where: string, expr: string) => defineTable('grp', t => ({
    id: t.serial().primaryKey(),
    a: t.int4(),
    b: t.int4(),
    c: t.int4(),
    total: t.int4().generated(expr),
  })).withIndexes([{ columns: ['a'], unique: true, name: 'grp_a_unique', where }])

  it('syncs a changed grouping and leaves what Postgres merely reprints', async () => {
    const v1 = grouped('(a = 1 OR b = 2) AND c = 3', '(a + b) * c')

    await sync([v1])

    expect((await sync([v1])).ops).toEqual([])

    const v2 = grouped('a = 1 OR (b = 2 AND c = 3)', 'a + (b * c)')
    const ops = (await sync([v2], true)).ops

    expect(ops.map(o => o.type).sort()).toEqual(['alter_column', 'create_index', 'drop_index'])
    expect(await admin.raw(`SELECT pg_get_indexdef('${q('grp_a_unique')}'::regclass) AS def`)).toEqual([{ def: expect.stringContaining('((a = 1) OR ((b = 2) AND (c = 3)))') }])
    expect((await sync([v2])).ops).toEqual([])
  })
})

describe('uniques', () => {
  it('syncs a one-column withUnique once, then drops it with the declaration', async () => {
    const v1 = defineTable('ua', t => ({ id: t.serial().primaryKey(), a: t.text(), b: t.text() })).withUnique(['a'])

    await sync([v1])

    expect((await sync([v1])).ops).toEqual([])

    const v2 = defineTable('ua', t => ({ id: t.serial().primaryKey(), a: t.text(), b: t.text() }))

    expect((await sync([v2], true)).ops.map(o => o.type)).toEqual(['drop_constraint'])
    expect((await sync([v2])).ops).toEqual([])
  })

  it('keeps a column UNIQUE and a one-column withUnique on another column apart', async () => {
    const table = defineTable('ub', t => ({ id: t.serial().primaryKey(), a: t.text().unique(), b: t.text() })).withUnique(['b'])

    await sync([table])

    expect((await sync([table])).ops).toEqual([])
  })
})

describe('foreign keys', () => {
  it('drops a composite foreign key made outside the definitions once', async () => {
    const parent = defineTable('fkp', t => ({ a: t.int4().primaryKey(), b: t.int4().primaryKey() }))
    const child = defineTable('fkc', t => ({ id: t.serial().primaryKey(), a: t.int4(), b: t.int4() }))

    await sync([parent, child])
    await admin.raw(`ALTER TABLE ${q('fkc')} ADD CONSTRAINT fkc_fk FOREIGN KEY (a, b) REFERENCES ${q('fkp')} (a, b)`)

    const { ops } = await sync([parent, child], true)

    expect(ops.filter(o => o.type === 'drop_fk')).toHaveLength(1)
    expect(await admin.raw(`SELECT conname FROM pg_constraint WHERE conrelid = '${q('fkc')}'::regclass AND contype = 'f'`)).toEqual([])
    expect((await sync([parent, child])).ops).toEqual([])
  })
})

describe('dropping referenced columns', () => {
  it('drops the foreign key before the column it points at, whatever the table order', async () => {
    const par1 = defineTable('par', t => ({ id: t.serial().primaryKey(), code: t.text().unique() }))
    const kid1 = defineTable('kid', t => ({ id: t.serial().primaryKey(), pcode: t.text().references(() => par1, 'code') }))

    await sync([par1, kid1])

    const par2 = defineTable('par', t => ({ id: t.serial().primaryKey() }))
    const kid2 = defineTable('kid', t => ({ id: t.serial().primaryKey() }))

    for (const tables of [[par2, kid2], [kid2, par2]]) {
      await sync([par1, kid1])

      const { ops } = await sync(tables, true)

      expect(ops.map(o => o.type)[0]).toBe('drop_fk')
      expect((await sync(tables)).ops).toEqual([])
    }
  })

  it('drops the foreign key of a column kept while the table it points at goes', async () => {
    const par1 = defineTable('par2', t => ({ id: t.serial().primaryKey(), code: t.text().unique() }))
    const kid1 = defineTable('kid2', t => ({ id: t.serial().primaryKey(), pcode: t.text().references(() => par1, 'code') }))

    await sync([par1, kid1])

    const kid2 = defineTable('kid2', t => ({ id: t.serial().primaryKey(), pcode: t.text() }))

    await sync([kid2], true)

    expect((await sync([kid2])).ops).toEqual([])
  })
})

describe('primary key defaults', () => {
  it('syncs a changed default of a primary key column, and a dropped one', async () => {
    const make = (fn?: string) => defineTable('pkd', t => ({ id: fn === undefined ? t.uuid().primaryKey() : t.uuid().primaryKey().defaultRaw(fn), n: t.int4().nullable() }))
    const v1 = make('gen_random_uuid()')

    await sync([v1])

    expect((await sync([v1])).ops).toEqual([])

    const v2 = make('\'00000000-0000-0000-0000-000000000001\'')

    expect((await sync([v2])).ops.map(o => o.sql)).toEqual([`ALTER TABLE "pkd" ALTER COLUMN "id" SET DEFAULT '00000000-0000-0000-0000-000000000001'`])
    expect(await admin.raw(`INSERT INTO ${q('pkd')} DEFAULT VALUES RETURNING id`)).toEqual([{ id: '00000000-0000-0000-0000-000000000001' }])
    expect((await sync([v2])).ops).toEqual([])

    const v3 = make()

    expect((await sync([v3])).ops.map(o => o.sql)).toEqual(['ALTER TABLE "pkd" ALTER COLUMN "id" DROP DEFAULT'])
  })

  it('leaves a serial primary key alone', async () => {
    const table = defineTable('pks', t => ({ id: t.serial().primaryKey() }))

    await sync([table])

    expect((await sync([table])).ops).toEqual([])
  })
})

// END
