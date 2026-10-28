import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createExprBuilder, defineTable, embedding, optimisticLock, OrmError, softDelete, timestamps, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

// The docker-compose image ships pgvector; a Postgres without it skips these.
const probe = createTestDb({ tables: [] })
const [available] = await probe.raw<{ n: number }>('SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = \'vector\'')

await probe.close()

// Each text's vector, as a provider would return it; an unknown text embeds to the origin.
const VECTORS: Record<string, number[]> = {
  'cats\nmeow': [1, 0, 0],
  'dogs\nwoof': [0, 1, 0],
  'kittens\nmeow': [0.9, 0.1, 0],
  'birds\ntweet': [0, 0, 1],
}

const calls: string[][] = []

async function embed(texts: string[]): Promise<number[][]> {
  calls.push(texts)

  return texts.map(text => VECTORS[text] ?? [0, 0, 0.5])
}

const docs = defineTable('em_docs', t => ({
  id: t.serial().primaryKey(),
  slug: t.text().unique(),
  title: t.text(),
  body: t.text(),
  views: t.int4().default(0),
  embedding: t.vector(3).nullable(),
})).withTrait(embedding({ column: 'embedding', source: row => `${row.title}\n${row.body}`, embed })).withTrait(softDelete())

const locked = defineTable('em_locked', t => ({
  id: t.serial().primaryKey(),
  title: t.text(),
  body: t.text(),
  embedding: t.vector(3).nullable(),
})).withTrait(embedding({ column: 'embedding', source: row => `${row.title}\n${row.body}`, embed })).withTrait(optimisticLock()).withTrait(timestamps()).withTrait(softDelete())

const plain = defineTable('em_plain', t => ({
  id: t.serial().primaryKey(),
  vec: t.vector(3),
}))

async function rejection(work: () => unknown): Promise<unknown> {
  try {
    await work()
  }
  catch (error) {
    return error
  }

  throw new Error('expected a rejection')
}

describe.skipIf(!available?.n)('the embedding trait and nearest()', () => {
  let db: Database

  beforeAll(async () => {
    db = createTestDb({ tables: [docs, locked, plain] })
    await db.sync({ allowDestructive: true })
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    await db.raw('TRUNCATE "em_docs", "em_locked", "em_plain" RESTART IDENTITY')
    calls.length = 0
  })

  async function seed() {
    return db.repo(docs).write.insertMany([
      { slug: 'c', title: 'cats', body: 'meow' },
      { slug: 'd', title: 'dogs', body: 'woof' },
      { slug: 'k', title: 'kittens', body: 'meow' },
      { slug: 'b', title: 'birds', body: 'tweet' },
    ])
  }

  it('embeds the rows of one insert in one call, returning and storing the vectors', async () => {
    const rows = await seed()
    const stored = await db.repo(docs).read.findMany(q => q.orderBy('id'))

    expect(calls).toEqual([['cats\nmeow', 'dogs\nwoof', 'kittens\nmeow', 'birds\ntweet']])
    expect(rows[0]!.embedding).toEqual([1, 0, 0])
    expect(stored.map(row => row.embedding)).toEqual([[1, 0, 0], [0, 1, 0], [0.9, 0.1, 0], [0, 0, 1]])
    expect(stored.every(row => typeof row.embeddingHash === 'string')).toBe(true)
  })

  it('re-embeds on an update only the rows whose source changed', async () => {
    await seed()
    calls.length = 0

    const write = db.repo(docs).write

    await write.updateMany({ views: 3 }, { slug: ['c', 'd'] })
    await write.updateMany({ title: 'cats' }, { slug: 'c' })
    expect(calls).toEqual([])

    const updated = await write.updateMany({ title: 'birds', body: 'tweet' }, { slug: { in: ['c', 'b'] } })
    const changed = updated.find(row => row.slug === 'c')

    expect(calls).toEqual([['birds\ntweet']])
    expect(changed!.embedding).toEqual([0, 0, 1])
  })

  it('embeds an upserted row only when its source changed', async () => {
    await seed()
    calls.length = 0

    await db.repo(docs).write.upsertMany([{ slug: 'c', title: 'cats', body: 'meow' }, { slug: 'x', title: 'dogs', body: 'woof' }], ['slug'], ['title', 'body'])

    expect(calls).toEqual([['dogs\nwoof']])
  })

  it('reads the k nearest rows with a typed distance, filtered, capped and scoped', async () => {
    await seed()
    await db.repo(docs).write.deleteMany({ slug: 'k' })

    const repo = db.repo(docs).read
    const nearest = await repo.nearest([1, 0, 0], { k: 2 })
    const distance: number = nearest[0]!.distance

    expect(nearest.map(row => row.slug)).toEqual(['c', 'd'])
    expect(distance).toBeCloseTo(0)
    expect((await repo.nearest([1, 0, 0], { k: 2, withTrashed: true })).map(row => row.slug)).toEqual(['c', 'k'])
    expect((await repo.nearest([1, 0, 0], { k: 5, maxDistance: 0.5 })).map(row => row.slug)).toEqual(['c'])
    expect((await repo.nearest([1, 0, 0], { k: 5, where: { slug: { neq: 'c' } }, metric: 'l2' })).map(row => row.slug)).toEqual(['d', 'b'])
  })

  it('types a distance read through computed() as a number', async () => {
    await db.repo(plain).write.insertMany([{ vec: [3, 4, 0] }])

    const [row] = await db.repo(plain).read.findMany(q => q.computed(e => e.vectorL2Distance('vec', [0, 0, 0]), 'd'))
    const d: number = row!.d

    expect(d).toBe(5)
    expect((await db.repo(plain).read.nearest([3, 4, 0], { k: 1, column: 'vec' }))[0]!.distance).toBeCloseTo(0)
    expect(await rejection(() => db.repo(plain).read.nearest([0, 0, 0], { k: 1 }))).toBeInstanceOf(ValidationError)
  })

  it('writes the vector back without a version bump, a new updatedAt or the scopes', async () => {
    const repo = db.repo(locked)
    const row = await repo.write.insertOne({ title: 'cats', body: 'meow' })
    const stored = await repo.read.findById(row.id)

    expect(stored).toEqual(row)

    const updated = await repo.write.updateWithLock({ title: 'dogs', body: 'woof' }, { id: row.id }, row.version)

    expect(updated.embedding).toEqual([0, 1, 0])
    expect(await repo.read.findById(updated.id)).toEqual(updated)

    await repo.write.deleteById(row.id)
    await repo.write.updateMany({ title: 'birds', body: 'tweet' }, { id: row.id }, { withTrashed: true })

    expect((await repo.read.findOne(q => q.withTrashed().where({ id: row.id })))!.embedding).toEqual([0, 0, 1])
  })

  it('refuses an unknown metric or vector type', async () => {
    const e = createExprBuilder<typeof plain.columns>()

    expect(await rejection(() => db.repo(plain).read.nearest([0, 0, 0], { k: 1, column: 'vec', metric: 'manhattan' as never }))).toBeInstanceOf(ValidationError)
    expect(() => e.vectorL2Distance('vec', [0, 0, 0], 'vector) OR 1=1 --' as never)).toThrow(ValidationError)
  })

  it('refuses a vector column that is not nullable', () => {
    expect(() => defineTable('em_bad', t => ({ id: t.serial().primaryKey(), title: t.text(), v: t.vector(3) }))
      .withTrait(embedding({ column: 'v', source: row => row.title, embed }))).toThrow(OrmError)
  })
})
