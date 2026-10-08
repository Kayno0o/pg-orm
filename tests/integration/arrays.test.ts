import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createTestDb, truncateAll } from '../helpers/db'
import { itemsTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
  await truncateAll(db)
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

describe('array columns — insert & select', () => {
  it('inserts and retrieves a text array', async () => {
    const repo = db.repo(itemsTable)
    const itemId = await repo.write.insertOne({ name: 'item1', tags: ['Seb', 'Sebouille', 'Sebobar'] }, { pk: true })
    const item = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', itemId)))

    expect(item.tags).toEqual(['Seb', 'Sebouille', 'Sebobar'])
  })

  it('inserts and retrieves an int array', async () => {
    const repo = db.repo(itemsTable)
    const itemId = await repo.write.insertOne({ name: 'item2', tags: [], scores: [10, 20, 30] }, { pk: true })
    const item = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', itemId)))

    expect(item.scores).toEqual([10, 20, 30])
  })

  it('inserts and retrieves an empty array', async () => {
    const repo = db.repo(itemsTable)
    const itemId = await repo.write.insertOne({ name: 'item3', tags: [] }, { pk: true })
    const item = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', itemId)))

    expect(item.tags).toEqual([])
  })

  it('inserts and retrieves a null array column', async () => {
    const repo = db.repo(itemsTable)
    const itemId = await repo.write.insertOne({ name: 'item4', tags: ['x'], scores: null }, { pk: true })
    const item = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', itemId)))

    expect(item.scores).toBeNull()
  })

  it('handles strings with special characters', async () => {
    const repo = db.repo(itemsTable)
    const itemId = await repo.write.insertOne({ name: 'item5', tags: ['hello world', 'foo,bar', 'say "hi"'] }, { pk: true })
    const item = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', itemId)))

    expect(item.tags).toEqual(['hello world', 'foo,bar', 'say "hi"'])
  })
})

describe('array columns — update', () => {
  it('updates a text array', async () => {
    const repo = db.repo(itemsTable)

    await repo.write.insertOne({ name: 'upd1', tags: ['old'] }, { pk: true })

    const [updated] = await repo.write.updateMany({ tags: ['new', 'values'] }, e => e.eq('name', 'upd1'))

    expect(updated!.tags).toEqual(['new', 'values'])
  })
})

describe('array columns — arrayContains filter', () => {
  it('finds items where array contains a value', async () => {
    const repo = db.repo(itemsTable)

    await repo.write.insertOne({ name: 'match', tags: ['alpha', 'beta'] }, { pk: true })
    await repo.write.insertOne({ name: 'nomatch', tags: ['gamma'] }, { pk: true })

    const results = await repo.read.findMany(q => q.where(e => e.arrayContains('tags', 'alpha')))

    expect(results).toHaveLength(1)
    expect(results[0]!.name).toBe('match')
  })
})

describe('array columns — arrayOverlap filter', () => {
  it('finds items where array overlaps', async () => {
    const repo = db.repo(itemsTable)

    await repo.write.insertOne({ name: 'match1', tags: ['a', 'b'] }, { pk: true })
    await repo.write.insertOne({ name: 'match2', tags: ['b', 'c'] }, { pk: true })
    await repo.write.insertOne({ name: 'nomatch', tags: ['d'] }, { pk: true })

    const results = await repo.read.findMany(q =>
      q.where(e => e.arrayOverlap('tags', ['a', 'c'])).orderBy('name', 'asc'),
    )

    expect(results).toHaveLength(2)
    expect(results.map(r => r.name)).toEqual(['match1', 'match2'])
  })
})
