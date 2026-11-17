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
