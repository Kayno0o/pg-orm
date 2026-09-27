import type { Database } from '../../src/index'
import { afterAll, describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'
import { allTables } from '../helpers/fixtures'

const grants = defineTable('pis_grants', t => ({ id: t.serial().primaryKey(), user_id: t.int4(), kind: t.text(), resource_id: t.int4().nullable() })).withIndexes([
  { columns: ['user_id', 'kind', 'resource_id'], unique: true, where: '"resource_id" IS NOT NULL' },
  { columns: ['user_id', 'kind'], unique: true, where: 'resource_id IS NULL AND kind = \'x\'' },
])

let db: Database

afterAll(async () => {
  await db.raw('DROP TABLE IF EXISTS "pis_grants"', [])
  await db.close({ timeout: 5000 })
})

describe('sync() and partial indexes', () => {
  it('finds nothing to do once a partial index exists, however its WHERE is spelled', async () => {
    db = createTestDb({ tables: [...allTables, grants] })
    await db.raw('DROP TABLE IF EXISTS "pis_grants"', [])
    await db.sync({ allowDestructive: true })

    expect((await db.sync()).ops).toEqual([])
  })

  it('still recreates an index whose predicate really changed', async () => {
    const changed = defineTable('pis_grants', t => ({ id: t.serial().primaryKey(), user_id: t.int4(), kind: t.text(), resource_id: t.int4().nullable() })).withIndexes([
      { columns: ['user_id', 'kind', 'resource_id'], unique: true, where: '"resource_id" > 0' },
      { columns: ['user_id', 'kind'], unique: true, where: 'resource_id IS NULL AND kind = \'x\'' },
    ])
    const other = createTestDb({ tables: [...allTables, changed] })

    try {
      const { ops } = await other.sync({ dryRun: true, allowDestructive: true })

      expect(ops.map(op => op.type)).toEqual(['drop_index', 'create_index'])
    }
    finally {
      await other.close({ timeout: 5000 })
    }
  })
})
