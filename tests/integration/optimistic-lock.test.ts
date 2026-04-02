import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { StaleRecordError } from '../../src/index'
import { createTestDb, truncateAll } from '../helpers/db'
import { versionedItemsTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

describe('Optimistic Lock', () => {
  it('inserts with default version 1', async () => {
    const repo = db.repo(versionedItemsTable)
    const item = await repo.insertOne({ name: 'Item 1', value: 100 })

    expect(item.version).toBe(1)
  })

  it('updateWithLock succeeds with correct version', async () => {
    const repo = db.repo(versionedItemsTable)
    const item = await repo.insertOne({ name: 'Item 1', value: 100 })

    const updated = await repo.updateWithLock(
      { value: 200 },
      e => e.eq('id', item.id),
      item.version,
    )

    expect(updated.value).toBe(200)
    expect(updated.version).toBe(2) // version incremented
  })

  it('updateWithLock throws StaleRecordError on version mismatch', async () => {
    const repo = db.repo(versionedItemsTable)
    const item = await repo.insertOne({ name: 'Item 1', value: 100 })

    // First update succeeds
    await repo.updateWithLock(
      { value: 200 },
      e => e.eq('id', item.id),
      item.version,
    )

    // Second update with stale version should fail
    expect(
      repo.updateWithLock(
        { value: 300 },
        e => e.eq('id', item.id),
        item.version, // stale version (1, but now it's 2)
      ),
    ).rejects.toThrow(StaleRecordError)
  })

  it('regular updateMany auto-increments version', async () => {
    const repo = db.repo(versionedItemsTable)
    const item = await repo.insertOne({ name: 'Item 1', value: 100 })

    const updated = await repo.updateMany(
      { value: 200 },
      e => e.eq('id', item.id),
    )

    expect(updated[0]!.version).toBe(2)
  })

  it('multiple sequential updates increment version correctly', async () => {
    const repo = db.repo(versionedItemsTable)
    let item = await repo.insertOne({ name: 'Item 1', value: 100 })

    item = await repo.updateWithLock({ value: 200 }, e => e.eq('id', item.id), 1)

    expect(item.version).toBe(2)

    item = await repo.updateWithLock({ value: 300 }, e => e.eq('id', item.id), 2)

    expect(item.version).toBe(3)
  })
})
