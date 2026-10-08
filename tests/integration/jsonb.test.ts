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
    }, { pk: true })
    const doc = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(doc.data).toEqual({ name: 'doc1', tags: ['a', 'b'], meta: { author: 'kay', version: 2 } })
  })

  it('preserves empty arrays and missing optional keys', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc2', tags: [] } }, { pk: true })
    const doc = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(doc.data.tags).toEqual([])
    expect(doc.data.meta).toBeUndefined()
  })

  it('preserves nullable JSONB column as null', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc3', tags: [] }, optional: null }, { pk: true })
    const doc = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(doc.optional).toBeNull()
  })

  it('round-trips strings with quotes, slashes, and unicode', async () => {
    const repo = db.repo(documentsTable)
    const tricky = { name: 'has "quotes" and \\slashes\\', tags: ['café', '\u{1F600}'] }
    const id = await repo.write.insertOne({ data: tricky }, { pk: true })
    const doc = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(doc.data).toEqual(tricky)
  })

  it('round-trips a top-level string array', async () => {
    const repo = db.repo(documentsTable)
    const rows = ['##########', '#        #', '#    @   #', '##########']
    const id = await repo.write.insertOne({ data: rows as never }, { pk: true })
    const doc = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(doc.data as unknown as string[]).toEqual(rows)
  })
})

describe('JSONB — full-column update', () => {
  it('replaces the JSONB value (does not merge)', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({
      data: { name: 'before', tags: ['old'], meta: { author: 'kay' } },
    }, { pk: true })

    const [updated] = await repo.write.updateMany(
      { data: { name: 'after', tags: ['new'] } },
      e => e.eq('id', id),
    )

    expect(updated!.data).toEqual({ name: 'after', tags: ['new'] })
    expect(updated!.data.meta).toBeUndefined()
  })

  it('updates a deeply nested object', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'deep', tags: [] } }, { pk: true })

    const [updated] = await repo.write.updateMany(
      { data: { name: 'deep', tags: ['t1'], meta: { author: 'kay', version: 9 } } },
      e => e.eq('id', id),
    )

    expect(updated!.data.meta).toEqual({ author: 'kay', version: 9 })
  })

  it('sets optional JSONB column from null to a value and back', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'opt', tags: [] }, optional: null }, { pk: true })

    await repo.write.updateMany({ optional: { foo: 1, bar: 'baz' } }, e => e.eq('id', id), { pk: true })

    const afterSet = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(afterSet.optional).toEqual({ foo: 1, bar: 'baz' })

    await repo.write.updateMany({ optional: null }, e => e.eq('id', id), { pk: true })

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
    const ids = await repo.write.insertMany(shapes.map(data => ({ data })), { pk: true })

    expect(ids).toHaveLength(3)

    const docs = await repo.read.findMany(q => q.orderBy('id', 'asc'))

    expect(docs.map(d => d.data)).toEqual(shapes)
  })
})

describe('JSONB — SQL NULL versus the JSON null scalar', () => {
  const typeOf = async (id: number): Promise<{ sqlNull: boolean, kind: string | null }> => {
    const [row] = await db.raw<{ sql_null: boolean, kind: string | null }>(
      'SELECT optional IS NULL AS sql_null, jsonb_typeof(optional) AS kind FROM documents WHERE id = $1',
      [id],
    )

    return { sqlNull: row!.sql_null, kind: row!.kind }
  }

  it('stores SQL NULL on insert, not the string "null"', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc', tags: [] }, optional: null }, { pk: true })

    expect(await typeOf(id)).toEqual({ sqlNull: true, kind: null })
  })

  it('stores SQL NULL when an update clears the column', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc', tags: [] }, optional: { a: 1 } }, { pk: true })

    await repo.write.updateOne({ optional: null }, e => e.eq('id', id), { pk: true })

    expect(await typeOf(id)).toEqual({ sqlNull: true, kind: null })
  })

  it('leaves a cleared column usable by jsonb functions expecting an array', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc', tags: [] }, optional: { a: 1 } }, { pk: true })

    await repo.write.updateOne({ optional: null }, e => e.eq('id', id), { pk: true })

    const [row] = await db.raw<{ n: number | null }>(
      'SELECT jsonb_array_length(optional) AS n FROM documents WHERE id = $1',
      [id],
    )

    expect(row!.n).toBeNull()
  })
})

describe('JSONB — clearing a column inside a transaction', () => {
  it('stores SQL NULL through a transaction-bound repo', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc', tags: [] }, optional: { a: 1 } }, { pk: true })

    await db.transaction(async (tx) => {
      await db.repo(documentsTable).using(tx).write.updateOne({ optional: null }, e => e.eq('id', id), { pk: true })
    })

    const [row] = await db.raw<{ kind: string | null }>(
      'SELECT jsonb_typeof(optional) AS kind FROM documents WHERE id = $1',
      [id],
    )

    expect(row!.kind).toBeNull()
  })
})

describe('JSONB — a nullable column the insert never names', () => {
  it('defaults to SQL NULL, not the JSON null scalar', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc', tags: [] } }, { pk: true })

    const [row] = await db.raw<{ kind: string | null, def: string | null }>(
      `SELECT jsonb_typeof(optional) AS kind,
              (SELECT column_default FROM information_schema.columns
               WHERE table_name = 'documents' AND column_name = 'optional') AS def
       FROM documents WHERE id = $1`,
      [id],
    )

    expect(row!.def).toBeNull()
    expect(row!.kind).toBeNull()
  })
})

describe('JSONB — stored as a structure, not as an encoded string', () => {
  const kindOf = async (id: number): Promise<string | null> => {
    const [row] = await db.raw<{ kind: string | null }>(
      'SELECT jsonb_typeof(optional) AS kind FROM documents WHERE id = $1',
      [id],
    )

    return row!.kind
  }

  it('stores an object as a jsonb object', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc', tags: [] }, optional: { a: 1 } }, { pk: true })

    expect(await kindOf(id)).toBe('object')
  })

  it('stores an array as a jsonb array, countable by jsonb_array_length', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc', tags: [] }, optional: [1, 2, 3] as never }, { pk: true })

    expect(await kindOf(id)).toBe('array')

    const [row] = await db.raw<{ n: number }>(
      'SELECT jsonb_array_length(optional) AS n FROM documents WHERE id = $1',
      [id],
    )

    expect(row!.n).toBe(3)
  })

  it('stores an array written by an update as a jsonb array', async () => {
    const repo = db.repo(documentsTable)
    const id = await repo.write.insertOne({ data: { name: 'doc', tags: [] } }, { pk: true })

    await repo.write.updateOne({ optional: [1, 2] as never }, e => e.eq('id', id), { pk: true })

    expect(await kindOf(id)).toBe('array')
  })
})
