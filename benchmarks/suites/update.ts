import type { Database } from '../../src/index'
import { users } from '../schema'
import { bench, defineSuite } from '../utils'

export function updateSuite(db: Database) {
  const repo = db.repo(users)

  return defineSuite('update', [
    bench('updateMany', async () => {
      await repo.write.updateMany({ bio: 'Updated bio text' }, e => e.and(e.eq('role', 'admin'), e.like('name', 'User 1%')))
    }),

    bench('updateWithLock', async () => {
      // Each call reads the current version then updates, so it is always fresh
      const row = await repo.read.findById(1)

      if (row)
        await repo.write.updateWithLock({ bio: `Locked update ${Date.now()}` }, { id: row.id }, row.version)
    }, { ops: 50 }),
  ])
}
