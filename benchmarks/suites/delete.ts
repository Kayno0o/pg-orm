import type { Database } from '../../src/index'
import { users } from '../schema'
import { bench, defineSuite } from '../utils'

export function deleteSuite(db: Database) {
  const repo = db.repo(users)
  let counter = 500_000

  return defineSuite('delete', [
    bench('deleteOne.soft', async () => {
      counter++
      const id = await repo.write.insertOne({ name: `DeleteMe ${counter}`, email: `bench-del-${counter}@test.com` }, { pk: true })

      // Measure soft-delete (insert overhead is constant across runs, cancels out in comparison)
      await repo.write.deleteById(id)
      // Clean up: force-delete so table doesn't grow
      await repo.write.forceDelete({ id })
    }, { ops: 50 }),

    bench('forceDelete', async () => {
      counter++
      const id = await repo.write.insertOne({ name: `ForceDeleteMe ${counter}`, email: `bench-fdel-${counter}@test.com` }, { pk: true })

      await repo.write.forceDelete({ id })
    }, { ops: 50 }),
  ])
}
