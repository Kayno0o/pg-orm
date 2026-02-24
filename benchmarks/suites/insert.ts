import type { Database } from '../../src/index'
import { users } from '../schema'
import { bench, defineSuite } from '../utils'

export function insertSuite(db: Database) {
  const repo = db.repo(users)
  let counter = 100_000

  return defineSuite('insert', [
    bench('insertOne', async () => {
      counter++
      await repo.insertOne({
        name: `BenchUser ${counter}`,
        email: `bench-insert-${counter}@test.com`,
      })
    }),

    bench('insertMany.100', async () => {
      const base = counter

      counter += 100
      const rows = Array.from({ length: 100 }, (_, i) => ({
        name: `Batch100 ${base + i}`,
        email: `bench-batch100-${base + i}@test.com`,
      }))

      await repo.insertMany(rows)
    }),

    bench('insertMany.1000', async () => {
      const base = counter

      counter += 1000
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        name: `Batch1000 ${base + i}`,
        email: `bench-batch1000-${base + i}@test.com`,
      }))

      await repo.insertMany(rows)
    }),
  ])
}
