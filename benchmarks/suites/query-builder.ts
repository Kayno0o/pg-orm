import { SelectBuilder } from '../../src/builder/query'
import { comments, posts, users } from '../schema'
import { bench, defineSuite } from '../utils'

export function queryBuilderSuite() {
  const userCols = Object.keys(users.columns)
  const postCols = Object.keys(posts.columns)

  return defineSuite('query-builder', [
    bench('simple.select', () => {
      new SelectBuilder('bench_users', userCols).toSQL()
    }),

    bench('where.complex', () => {
      new SelectBuilder('bench_users', userCols)
        .where(e =>
          e.or(
            e.and(e.eq('role', 'admin'), e.like('name', 'A%')),
            e.and(e.neq('role', 'banned'), e.isNotNull('bio'), e.gt('id', 100)),
          ),
        )
        .orderBy('name', 'asc')
        .limit(50)
        .offset(10)
        .toSQL()
    }),

    bench('join.multi', () => {
      new SelectBuilder('bench_posts', postCols)
        .join('bench_users', 'u', e => e.raw('"u"."id" = "bench_posts"."authorId"'))
        .join('bench_comments', 'c', e => e.raw('"c"."postId" = "bench_posts"."id"'))
        .where(e => e.eq('published', true))
        .orderBy('id', 'desc')
        .limit(100)
        .toSQL()
    }),

    bench('aggregate', () => {
      new SelectBuilder('bench_posts', postCols)
        .groupBy('authorId')
        .aggregate(e => ({
          total: e.countCol(),
          avgViews: e.avg('views'),
          maxViews: e.max('views'),
        }))
        .toSQL()
    }),

    bench('subquery', () => {
      const sub = new SelectBuilder('bench_comments', Object.keys(comments.columns))
        .where(e => e.raw('"bench_comments"."authorId" = "bench_users"."id"'))

      new SelectBuilder('bench_users', userCols)
        .where(e => e.exists(sub))
        .orderBy('id', 'asc')
        .limit(20)
        .toSQL()
    }),
  ])
}
