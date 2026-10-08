import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
import { syncSchemaHarness } from '../helpers/schema-sync'

const SCHEMA = 'pgorm_sync_ddl'
const { admin, sync } = syncSchemaHarness(SCHEMA)

async function enumValues(name: string): Promise<string[]> {
  const rows = await admin.raw<{ value: string }>(`
    SELECT e.enumlabel AS value FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = $1 AND n.nspname = $2 ORDER BY e.enumsortorder
  `, [name, SCHEMA])

  return rows.map(r => r.value)
}

describe('sync() emits DDL Postgres accepts', () => {
  it('drops foreign keys and indexes before the tables and columns they belong to', async () => {
    const parents = defineTable('parents', t => ({ id: t.serial().primaryKey() }))
    const a = defineTable('a', t => ({ id: t.serial().primaryKey() }))
    const b = defineTable('b', t => ({ id: t.serial().primaryKey(), a_id: t.int4().references(() => a, 'id') }))
    const v1 = defineTable('children', t => ({
      id: t.serial().primaryKey(),
      parent_id: t.int4().references(() => parents, 'id'),
      label: t.text().index(),
    }))

    await sync([parents, a, b, v1])

    const v2 = defineTable('children', t => ({ id: t.serial().primaryKey(), parent_id: t.int4() }))

    await sync([v2], true)

    expect(await admin.raw(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = '${SCHEMA}' AND table_name <> '_pgorm_migrations'`)).toEqual([{ name: 'children' }])
    expect((await sync([v2])).ops).toEqual([])
  })

  it('removes an enum value from live columns only, an array and a default included', async () => {
    const v1 = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('item_status', ['a', 'b', 'c']).default('a'),
      history: t.array(t.enum('item_status', ['a', 'b', 'c'])).default(['a']),
    }))

    await sync([v1])
    await admin.raw(`INSERT INTO "${SCHEMA}"."items" ("status", "history") VALUES ('b', '{a,b}')`)

    const v2 = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('item_status', ['a', 'b']).default('a'),
      history: t.array(t.enum('item_status', ['a', 'b'])).default(['a']),
    }))
    // A table the same sync creates, which the replacement must leave to its CREATE TABLE.
    const others = defineTable('others', t => ({ id: t.serial().primaryKey(), status: t.enum('item_status', ['a', 'b']) }))

    await sync([v2, others], true)

    expect(await enumValues('item_status')).toEqual(['a', 'b'])
    expect(await admin.raw(`SELECT "status"::text AS "status", "history"::text AS "history" FROM "${SCHEMA}"."items"`)).toEqual([{ status: 'b', history: '{a,b}' }])
    await admin.raw(`INSERT INTO "${SCHEMA}"."items" DEFAULT VALUES`)
    expect(await admin.raw(`SELECT "status"::text AS "status", "history"::text AS "history" FROM "${SCHEMA}"."items" ORDER BY "id" DESC LIMIT 1`)).toEqual([{ status: 'a', history: '{a}' }])
    expect((await sync([v2, others])).ops).toEqual([])
  })

  it('creates the type of an enum array column', async () => {
    const table = defineTable('tagged', t => ({ id: t.serial().primaryKey(), tags: t.array(t.enum('tag_kind', ['x', 'y'])) }))

    await sync([table])

    expect(await enumValues('tag_kind')).toEqual(['x', 'y'])
    expect((await sync([table])).ops).toEqual([])
  })

  it('changes column types with a cast, their defaults dropped first and set again after', async () => {
    const v1 = defineTable('conv', t => ({
      id: t.serial().primaryKey(),
      n: t.text().default('1'),
      flag: t.text().default('true'),
      ref: t.text(),
      kind: t.text().default('a'),
      tags: t.jsonb(),
      wide: t.int4().default(5),
    }))

    await sync([v1])
    await admin.raw(`INSERT INTO "${SCHEMA}"."conv" ("n", "flag", "ref", "kind", "tags") VALUES ('42', 'false', '0b8e4a10-3f2c-4c1e-9d7a-2a1f0c3b5e6d', 'b', '["x", "y"]')`)

    const v2 = defineTable('conv', t => ({
      id: t.serial().primaryKey(),
      n: t.int4().default(1),
      flag: t.bool().default(true),
      ref: t.uuid(),
      kind: t.enum('conv_kind', ['a', 'b']).default('a'),
      tags: t.array(t.text()),
      wide: t.int8().default(5n),
    }))

    await sync([v2], true)

    expect(await admin.raw(`SELECT "n", "flag", "ref"::text AS "ref", "kind"::text AS "kind", "tags", "wide"::int AS "wide" FROM "${SCHEMA}"."conv"`)).toEqual([
      { n: 42, flag: false, ref: '0b8e4a10-3f2c-4c1e-9d7a-2a1f0c3b5e6d', kind: 'b', tags: ['x', 'y'], wide: 5 },
    ])
    await admin.raw(`INSERT INTO "${SCHEMA}"."conv" ("ref", "tags") VALUES (gen_random_uuid(), '{}')`)
    expect(await admin.raw(`SELECT "n", "flag", "kind"::text AS "kind", "wide"::int AS "wide" FROM "${SCHEMA}"."conv" ORDER BY "id" DESC LIMIT 1`)).toEqual([{ n: 1, flag: true, kind: 'a', wide: 5 }])
    expect((await sync([v2])).ops).toEqual([])
  })

  it('keeps generated index and constraint names within 63 bytes, so the next sync finds them', async () => {
    const tableName = `t${'a'.repeat(44)}`
    const colName = `c${'b'.repeat(29)}`
    const target = defineTable('target', t => ({ id: t.serial().primaryKey() }))
    const v1 = defineTable(tableName, t => ({ id: t.serial().primaryKey(), [colName]: t.int4().references(() => target, 'id').index() }))

    await sync([target, v1])

    const v2 = defineTable(tableName, t => ({
      id: t.serial().primaryKey(),
      [colName]: t.int4().references(() => target, 'id').index(),
      [`${colName}_2`]: t.text().nullable().unique(),
    }))

    await sync([target, v2])

    const names = await admin.raw<{ name: string }>(`SELECT conname AS name FROM pg_constraint WHERE conrelid = '"${SCHEMA}"."${tableName}"'::regclass UNION ALL SELECT indexname FROM pg_indexes WHERE schemaname = '${SCHEMA}' AND tablename = '${tableName}'`)

    expect(names.every(r => r.name.length <= 63)).toBe(true)
    expect((await sync([target, v2])).ops).toEqual([])
  })
})
