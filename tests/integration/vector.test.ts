import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'

const docs = defineTable('vec_docs', t => ({
  id: t.int4().primaryKey(),
  embedding: t.vector(3),
}))

// The docker-compose image ships pgvector; a Postgres without it skips these.
const probe = createTestDb({ tables: [] })
const [available] = await probe.raw<{ n: number }>('SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = \'vector\'')

await probe.close()

describe.skipIf(!available?.n)('vector distances on pgvector', () => {
  const db = createTestDb({ tables: [docs] })

  beforeAll(async () => {
    await db.raw('CREATE EXTENSION IF NOT EXISTS vector')
    await db.sync({ allowDestructive: true })
    await db.raw('DELETE FROM "vec_docs"')
    await db.raw('INSERT INTO "vec_docs" ("id", "embedding") VALUES (1, \'[1,0,0]\'), (2, \'[0,1,0]\'), (3, \'[0.9,0.1,0]\')')
  })

  afterAll(async () => {
    await db.close()
  })

  for (const vec of [[1, 0, 0], new Float32Array([1, 0, 0])]) {
    it(`orders and filters on a distance to a ${vec.constructor.name}`, async () => {
      const nearest = await db.repo(docs).read.findMany(q => q.pick('id').orderBy(e => e.vectorCosineDistance('embedding', vec)))
      const byL2 = await db.repo(docs).read.findMany(q => q.pick('id').orderBy(e => e.vectorL2Distance('embedding', vec)))
      const close = await db.repo(docs).read.findMany(q => q.pick('id').where(e => e.lt(e.vectorCosineDistance('embedding', vec), 0.1)).orderBy('id'))

      expect(nearest.map(r => r.id)).toEqual([1, 3, 2])
      expect(byL2.map(r => r.id)).toEqual([1, 3, 2])
      expect(close.map(r => r.id)).toEqual([1, 3])
    })
  }
})
