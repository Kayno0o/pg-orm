import type { Database } from '../../src/index'
import { users } from '../schema'
import { bench, defineSuite } from '../utils'

export function insertSuite(db: Database) {
  const repo = db.repo(users)
  let counter = 100_000

  return defineSuite('insert', [
    bench('insertOne', async () => {
      counter++
      const row = await repo.insertOne({
        name: `BenchUser ${counter}`,
        email: `bench-insert-${counter}@test.com`,
      })

      await repo.forceDelete(e => e.eq('id', row.id))
    }, { ops: 50 }),

    bench('insertMany.100', async () => {
      const base = counter

      counter += 100
      const rows = Array.from({ length: 100 }, (_, i) => ({
        name: `Batch100 ${base + i}`,
        email: `bench-batch100-${base + i}@test.com`,
      }))
      const inserted = await repo.insertMany(rows)

      await repo.forceDelete(e => e.in('id', inserted.map(r => r.id)))
    }, { ops: 10 }),

    bench('insertMany.1000', async () => {
      const base = counter

      counter += 1000
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        name: `Batch1000 ${base + i}`,
        email: `bench-batch1000-${base + i}@test.com`,
      }))
      const inserted = await repo.insertMany(rows)

      await repo.forceDelete(e => e.in('id', inserted.map(r => r.id)))
    }, { ops: 5 }),
  ])
}
