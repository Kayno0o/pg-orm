import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createTestDb, truncateAll } from '../helpers/db'
import { documentsTable } from '../helpers/fixtures'

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

describe('JSONB — insert & select round-trip', () => {
  it('round-trips a nested object', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({
      data: { name: 'doc1', tags: ['a', 'b'], meta: { author: 'kay', version: 2 } },
    })
    const doc = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(doc.data).toEqual({ name: 'doc1', tags: ['a', 'b'], meta: { author: 'kay', version: 2 } })
  })

  it('preserves empty arrays and missing optional keys', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc2', tags: [] } })
    const doc = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(doc.data.tags).toEqual([])
    expect(doc.data.meta).toBeUndefined()
  })

  it('preserves nullable JSONB column as null', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc3', tags: [] }, optional: null })
    const doc = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(doc.optional).toBeNull()
  })

  it('round-trips strings with quotes, slashes, and unicode', async () => {
    const repo = db.repo(documentsTable)
    const tricky = { name: 'has "quotes" and \\slashes\\', tags: ['café', '\u{1F600}'] }
    const id = await repo.write.insertOne({ data: tricky })
    const doc = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(doc.data).toEqual(tricky)
  })
})

describe('JSONB — full-column update', () => {
  it('replaces the JSONB value (does not merge)', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({
      data: { name: 'before', tags: ['old'], meta: { author: 'kay' } },
    })

    const [updated] = await repo.write.updateMany(
      { data: { name: 'after', tags: ['new'] } },
      e => e.eq('id', id),
      { full: true },
    )

    expect(updated!.data).toEqual({ name: 'after', tags: ['new'] })
    expect(updated!.data.meta).toBeUndefined()
  })

  it('updates a deeply nested object', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'deep', tags: [] } })

    const [updated] = await repo.write.updateMany(
      { data: { name: 'deep', tags: ['t1'], meta: { author: 'kay', version: 9 } } },
      e => e.eq('id', id),
      { full: true },
    )

    expect(updated!.data.meta).toEqual({ author: 'kay', version: 9 })
  })

  it('sets optional JSONB column from null to a value and back', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'opt', tags: [] }, optional: null })

    await repo.write.updateMany({ optional: { foo: 1, bar: 'baz' } }, e => e.eq('id', id))

    const afterSet = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(afterSet.optional).toEqual({ foo: 1, bar: 'baz' })

    await repo.write.updateMany({ optional: null }, e => e.eq('id', id))

    const afterClear = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(afterClear.optional).toBeNull()
  })
})

describe('JSONB — insertMany & batch', () => {
  it('inserts and retrieves a batch of distinct JSONB shapes', async () => {
    const repo = db.repo(documentsTable)
    const shapes = [
      { name: 'a', tags: ['x'] },
      { name: 'b', tags: ['y', 'z'], meta: { version: 1 } },
      { name: 'c', tags: [] },
    ]
    const ids = await repo.write.insertMany(shapes.map(data => ({ data })))

    expect(ids).toHaveLength(3)

    const docs = await repo.read.findMany(q => q.orderBy('id', 'asc'))

    expect(docs.map(d => d.data)).toEqual(shapes)
  })
})
