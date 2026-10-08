import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'

// After-write hooks are typed as receiving `InferSelect` rows, the same shape afterSelect gets: every column, mapped (bigint as bigint, jsonb parsed).
const hookRows = defineTable('hook_rows', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
  big: t.bigint(),
  data: t.jsonb<{ n: number }>(),
}))

const seen: Record<string, Record<string, unknown>[]> = {}

for (const event of ['afterInsert', 'afterUpdate', 'afterDelete', 'afterSelect'] as const) {
  hookRows.hook(event, (rows) => {
    seen[event] = rows as Record<string, unknown>[]
  })
}

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [hookRows] })
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  await db.raw('TRUNCATE "hook_rows"', [])

  for (const key of Object.keys(seen)) delete seen[key]
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

describe('After-write hook rows', () => {
  const expected = { name: 'a', big: 10n, data: { n: 1 } }

  it('afterInsert receives the full mapped row', async () => {
    await db.repo(hookRows).write.insertOne({ name: 'a', big: 10n, data: { n: 1 } }, { pk: true })

    expect(seen.afterInsert?.[0]).toMatchObject(expected)
  })

  it('afterUpdate receives the full mapped row', async () => {
    const id = await db.repo(hookRows).write.insertOne({ name: 'a', big: 1n, data: { n: 1 } }, { pk: true })

    await db.repo(hookRows).write.updateById(id, { big: 10n }, { pk: true })

    expect(seen.afterUpdate?.[0]).toMatchObject(expected)
  })

  it('afterDelete receives the full mapped row', async () => {
    const id = await db.repo(hookRows).write.insertOne({ name: 'a', big: 10n, data: { n: 1 } }, { pk: true })

    await db.repo(hookRows).write.deleteById(id, { pk: true })

    expect(seen.afterDelete?.[0]).toMatchObject(expected)
  })

  it('afterSelect and afterInsert see the same row shape', async () => {
    const id = await db.repo(hookRows).write.insertOne({ name: 'a', big: 10n, data: { n: 1 } }, { pk: true })

    await db.repo(hookRows).read.findById(id)

    expect(seen.afterInsert?.[0]).toEqual(seen.afterSelect?.[0])
  })
})
