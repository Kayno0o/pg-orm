import type { AnyTableDef, Database } from '../../src/index'
import { afterEach, describe, expect, it } from 'bun:test'
import { CheckError, defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'
import { allTables } from '../helpers/fixtures'

const opened: Database[] = []

function syncDb(table: AnyTableDef): Database {
  const db = createTestDb({ tables: [...allTables, table] })

  opened.push(db)

  return db
}

async function checks(db: Database): Promise<string[]> {
  const rows = await db.raw<{ name: string }>(`SELECT conname AS name FROM pg_constraint WHERE contype = 'c' AND conrelid = '"cs_items"'::regclass ORDER BY conname`, [])

  return rows.map(r => r.name)
}

afterEach(async () => {
  await opened[0]?.raw('DROP TABLE IF EXISTS "cs_items"', [])

  for (const db of opened.splice(0))
    await db.close({ timeout: 5000 })
})

const v1 = defineTable('cs_items', t => ({ id: t.serial().primaryKey(), qty: t.int4().min(0), code: t.text().check('length(code) > 1') }))
const v2 = defineTable('cs_items', t => ({ id: t.serial().primaryKey(), qty: t.int4().min(1), code: t.text() }))

describe('sync() and CHECK constraints', () => {
  it('names the checks of a new table so a second sync finds nothing to do', async () => {
    const db = syncDb(v1)

    await db.raw('DROP TABLE IF EXISTS "cs_items"', [])
    await db.sync({ allowDestructive: true })

    expect(await checks(db)).toEqual([expect.stringMatching(/^cs_items_code_check_[0-9a-f]{8}$/), expect.stringMatching(/^cs_items_qty_check_[0-9a-f]{8}$/)])
    expect((await db.sync()).ops).toEqual([])
  })

  it('replaces a changed check and drops a removed one', async () => {
    const before = syncDb(v1)

    await before.raw('DROP TABLE IF EXISTS "cs_items"', [])
    await before.sync({ allowDestructive: true })

    const after = syncDb(v2)
    const { ops } = await after.sync()

    expect(ops.map(op => op.type).sort()).toEqual(['add_constraint', 'drop_constraint', 'drop_constraint'])
    expect(await checks(after)).toEqual([expect.stringMatching(/^cs_items_qty_check_/)])
    await expect(after.repo(v2).write.insertOne({ qty: 0, code: 'x' })).rejects.toBeInstanceOf(CheckError)
    expect(await after.repo(v2).write.insertOne({ qty: 1, code: 'x' })).toBeGreaterThan(0)
    expect((await after.sync()).ops).toEqual([])
  })

  it('takes over the unnamed checks earlier versions created, and leaves hand-written ones alone', async () => {
    const db = syncDb(v1)

    await db.raw('DROP TABLE IF EXISTS "cs_items"', [])
    await db.raw('CREATE TABLE "cs_items" ("id" serial PRIMARY KEY, "qty" int4 CHECK ("qty" >= 0), "code" text CHECK (length(code) > 1), CONSTRAINT "cs_items_sane" CHECK ("qty" < 1000000))', [])

    expect(await checks(db)).toEqual(['cs_items_code_check', 'cs_items_qty_check', 'cs_items_sane'])

    await db.sync()

    expect(await checks(db)).toEqual([expect.stringMatching(/^cs_items_code_check_/), expect.stringMatching(/^cs_items_qty_check_/), 'cs_items_sane'])
    expect((await db.sync()).ops).toEqual([])
  })
})
