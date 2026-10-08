import { SelectBuilder } from '../../src/builder/query'
import { comments, posts, users } from '../schema'
import { bench, defineSuite } from '../utils'

export function queryBuilderSuite() {
  return defineSuite('query-builder', [
    bench('simple.select', () => {
      new SelectBuilder<typeof users.columns>(users).toSQL()
    }),

    bench('where.complex', () => {
      new SelectBuilder<typeof users.columns>(users)
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
      new SelectBuilder<typeof posts.columns>(posts)
        .join(users, 'u', e => e.eq('authorId', e.ref('u.id')))
        .join(comments, 'c', e => e.eq('id', e.ref('c.postId')))
        .where(e => e.eq('published', true))
        .orderBy('id', 'desc')
        .limit(100)
        .toSQL()
    }),

    bench('aggregate', () => {
      new SelectBuilder<typeof posts.columns>(posts)
        .groupBy('authorId')
        .aggregate(e => ({
          total: e.countCol(),
          avgViews: e.avg('views'),
          maxViews: e.max('views'),
        }))
        .toSQL()
    }),

    bench('subquery', () => {
      const sub = new SelectBuilder<typeof comments.columns>(comments).where(e => e.eq('authorId', e.ref('bench_users.id')))

      new SelectBuilder<typeof users.columns>(users)
        .where(e => e.exists(sub))
        .orderBy('id', 'asc')
        .limit(20)
        .toSQL()
    }),

    bench('in.1000', () => {
      new SelectBuilder<typeof users.columns>(users)
        .where({ id: Array.from({ length: 1000 }, (_, i) => i) })
        .toSQL()
    }),
  ])
}
