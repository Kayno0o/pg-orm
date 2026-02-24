import type { Database } from '../../src/index'
import { posts, users } from '../schema'
import { bench, defineSuite } from '../utils'

export function relationsSuite(db: Database) {
  const userRepo = db.repo(users)
  const postRepo = db.repo(posts)

  return defineSuite('relations', [
    bench('include.hasMany', async () => {
      await userRepo.findMany(q =>
        q.include('posts').limit(20),
      )
    }),

    bench('include.belongsTo', async () => {
      await postRepo.findMany(q =>
        q.include('author').limit(50),
      )
    }),

    bench('include.nested', async () => {
      await userRepo.findMany(q =>
        q.include('posts', sq =>
          sq.where(e => e.eq('published', true)).include('comments')).limit(10),
      )
    }),
  ])
}
