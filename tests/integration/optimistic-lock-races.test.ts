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

describe('Optimistic lock — concurrency races', () => {
  it('two concurrent updateWithLock: exactly one wins, one rejects with StaleRecordError', async () => {
    const repo = db.repo(versionedItemsTable)
    const id = await repo.write.insertOne({ name: 'race', value: 0 })

    const results = await Promise.allSettled([
      repo.write.updateWithLock({ value: 100 }, e => e.eq('id', id), 1),
      repo.write.updateWithLock({ value: 200 }, e => e.eq('id', id), 1),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleRecordError)

    const final = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(final.version).toBe(2)
    expect([100, 200]).toContain(final.value)
  })

  it('N=10 concurrent updates with same stale version: exactly one succeeds, nine fail', async () => {
    const N = 10
    const repo = db.repo(versionedItemsTable)
    const id = await repo.write.insertOne({ name: 'race-n', value: 0 })

    const attempts = Array.from({ length: N }, (_, i) =>
      repo.write.updateWithLock({ value: i + 1 }, e => e.eq('id', id), 1))
    const results = await Promise.allSettled(attempts)

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(N - 1)
    expect(
      rejected.every(r => (r as PromiseRejectedResult).reason instanceof StaleRecordError),
    ).toBe(true)

    const final = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(final.version).toBe(2)
  })

  it('sequential updates with proper version threading all succeed and increment by 1', async () => {
    const repo = db.repo(versionedItemsTable)
    const id = await repo.write.insertOne({ name: 'seq', value: 0 })
    let current = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    for (let i = 0; i < 5; i++) {
      const updated = await repo.write.updateWithLock(
        { value: current.value + 1 },
        e => e.eq('id', id),
        current.version,
      )

      expect(updated.version).toBe(current.version + 1)
      current = updated
    }

    expect(current.version).toBe(6)
    expect(current.value).toBe(5)
  })

  it('update on deleted row throws StaleRecordError', async () => {
    const repo = db.repo(versionedItemsTable)
    const id = await repo.write.insertOne({ name: 'rip', value: 0 })

    await repo.write.deleteMany(e => e.eq('id', id))

    expect(
      repo.write.updateWithLock({ value: 1 }, e => e.eq('id', id), 1),
    ).rejects.toBeInstanceOf(StaleRecordError)
  })

  it('parallel updates on different rows do not interfere', async () => {
    const repo = db.repo(versionedItemsTable)
    const ids = await repo.write.insertMany(
      Array.from({ length: 5 }, (_, i) => ({ name: `r${i}`, value: 0 })),
    )

    const results = await Promise.all(
      ids.map(id => repo.write.updateWithLock({ value: 42 }, e => e.eq('id', id), 1)),
    )

    expect(results).toHaveLength(5)
    expect(results.every(r => r.value === 42 && r.version === 2)).toBe(true)
  })
})
