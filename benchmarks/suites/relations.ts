import type { Database } from '../../src/index'
import { comments, posts, users } from '../schema'
import { bench, defineSuite } from '../utils'

export function relationsSuite(db: Database) {
  const userRepo = db.repo(users)
  const postRepo = db.repo(posts)

  return defineSuite('relations', [
    bench('include.hasMany', async () => {
      await userRepo.read.findMany(q => q.include('posts').limit(20))
    }),

    bench('include.belongsTo', async () => {
      await postRepo.read.findMany(q => q.include('author').limit(50))
    }),

    bench('include.nested', async () => {
      await userRepo.read.findMany(q => q.include('posts', posts, sq => sq.where({ published: true }).include('comments', comments, cq => cq)).limit(10))
    }),
  ])
}
