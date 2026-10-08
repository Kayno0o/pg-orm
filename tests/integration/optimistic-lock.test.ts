import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { NotFoundError, StaleRecordError } from '../../src/index'
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
    const itemId = await repo.write.insertOne({ name: 'Item 1', value: 100 }, { pk: true })
    const item = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', itemId)))

    expect(item.version).toBe(1)
  })

  it('updateWithLock succeeds with correct version', async () => {
    const repo = db.repo(versionedItemsTable)
    const itemId = await repo.write.insertOne({ name: 'Item 1', value: 100 }, { pk: true })
    const item = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', itemId)))

    const updated = await repo.write.updateWithLock(
      { value: 200 },
      e => e.eq('id', itemId),
      item.version,
    )

    expect(updated.value).toBe(200)
    expect(updated.version).toBe(2) // version incremented
  })

  it('updateWithLock throws StaleRecordError on version mismatch', async () => {
    const repo = db.repo(versionedItemsTable)
    const itemId = await repo.write.insertOne({ name: 'Item 1', value: 100 }, { pk: true })
    const item = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', itemId)))

    // First update succeeds
    await repo.write.updateWithLock(
      { value: 200 },
      e => e.eq('id', itemId),
      item.version,
      { pk: true },
    )

    // Second update with stale version should fail
    expect(
      repo.write.updateWithLock(
        { value: 300 },
        e => e.eq('id', itemId),
        item.version,
        { pk: true }, // stale version (1, but now it's 2)
      ),
    ).rejects.toThrow(StaleRecordError)
  })

  it('updateWithLock throws NotFoundError when no row matches at all', async () => {
    const repo = db.repo(versionedItemsTable)

    await expect(repo.write.updateWithLock({ value: 300 }, e => e.eq('id', 999), 1)).rejects.toThrow(NotFoundError)
  })

  it('regular updateMany auto-increments version', async () => {
    const repo = db.repo(versionedItemsTable)
    const itemId = await repo.write.insertOne({ name: 'Item 1', value: 100 }, { pk: true })

    const updated = await repo.write.updateMany(
      { value: 200 },
      e => e.eq('id', itemId),
    )

    expect(updated[0]!.version).toBe(2)
  })

  it('multiple sequential updates increment version correctly', async () => {
    const repo = db.repo(versionedItemsTable)
    const itemId = await repo.write.insertOne({ name: 'Item 1', value: 100 }, { pk: true })

    let result = await repo.write.updateWithLock({ value: 200 }, e => e.eq('id', itemId), 1)

    expect(result.version).toBe(2)

    result = await repo.write.updateWithLock({ value: 300 }, e => e.eq('id', itemId), 2)

    expect(result.version).toBe(3)
  })
})
