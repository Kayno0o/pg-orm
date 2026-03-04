import type { Database } from '../../src/index'
import { users } from '../schema'
import { bench, defineSuite } from '../utils'

export function selectSuite(db: Database) {
  const repo = db.repo(users)

  return defineSuite('select', [
    bench('findOne.byPk', async () => {
      await repo.findOne(q => q.where(e => e.eq('id', 1)))
    }),

    bench('findMany.where', async () => {
      await repo.findMany(q =>
        q.where(e => e.eq('role', 'admin')).limit(50),
      )
    }),

    bench('findMany.complexExpr', async () => {
      await repo.findMany(q =>
        q.where(e =>
          e.or(
            e.and(e.eq('role', 'admin'), e.like('name', 'User 1%')),
            e.and(e.eq('role', 'user'), e.isNotNull('bio')),
          ),
        ).limit(50),
      )
    }),

    bench('count', async () => {
      await repo.count()
    }),

    bench('exists', async () => {
      await repo.exists(e => e.eq('id', 1))
    }),
  ])
}
