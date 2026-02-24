import type { Database } from '../../src/index'
import { users } from '../schema'
import { bench, defineSuite } from '../utils'

export function deleteSuite(db: Database) {
  const repo = db.repo(users)
  let counter = 500_000

  return defineSuite('delete', [
    bench('deleteOne.soft', async () => {
      // Insert a row then soft-delete it
      counter++
      const row = await repo.insertOne({
        name: `DeleteMe ${counter}`,
        email: `bench-del-${counter}@test.com`,
      })

      await repo.deleteOne(e => e.eq('id', row.id))
    }, { ops: 1 }),

    bench('forceDelete', async () => {
      // Insert a row then hard-delete it
      counter++
      const row = await repo.insertOne({
        name: `ForceDeleteMe ${counter}`,
        email: `bench-fdel-${counter}@test.com`,
      })

      await repo.forceDelete(e => e.eq('id', row.id))
    }, { ops: 1 }),
  ])
}
