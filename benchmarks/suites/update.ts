import type { Database } from '../../src/index'
import { users } from '../schema'
import { bench, defineSuite } from '../utils'

export function updateSuite(db: Database) {
  const repo = db.repo(users)

  return defineSuite('update', [
    bench('updateMany', async () => {
      await repo.updateMany(
        { bio: 'Updated bio text' },
        e => e.and(e.eq('role', 'admin'), e.like('name', 'User 1%')),
      )
    }),

    bench('updateWithLock', async () => {
      const row = await repo.findOne(q => q.where(e => e.eq('id', 1)))

      if (row) {
        await repo.updateWithLock(
          { bio: `Locked update ${Date.now()}` },
          e => e.eq('id', row.id),
          (row as any).version,
        )
      }
    }, { ops: 1 }),
  ])
}
