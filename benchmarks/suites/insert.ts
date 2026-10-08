import type { Database } from '../../src/index'
import { users } from '../schema'
import { bench, defineSuite } from '../utils'

export function insertSuite(db: Database) {
  const repo = db.repo(users)
  let counter = 100_000

  const batch = (label: string, size: number) => {
    const base = counter

    counter += size

    return Array.from({ length: size }, (_, i) => ({ name: `${label} ${base + i}`, email: `bench-${label}-${base + i}@test.com` }))
  }

  return defineSuite('insert', [
    bench('insertOne', async () => {
      counter++
      const id = await repo.write.insertOne({ name: `BenchUser ${counter}`, email: `bench-insert-${counter}@test.com` }, { pk: true })

      await repo.write.forceDelete({ id })
    }, { ops: 50 }),

    bench('insertMany.100', async () => {
      const ids = await repo.write.insertMany(batch('batch100', 100), { pk: true })

      await repo.write.forceDelete({ id: ids })
    }, { ops: 10 }),

    bench('insertMany.1000', async () => {
      const ids = await repo.write.insertMany(batch('batch1000', 1000), { pk: true })

      await repo.write.forceDelete({ id: ids })
    }, { ops: 5 }),
  ])
}
