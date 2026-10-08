import type { Database } from '../../src/index'
import { posts } from '../schema'
import { bench, defineSuite } from '../utils'

export function paginationSuite(db: Database) {
  const repo = db.repo(posts)

  return defineSuite('pagination', [
    bench('offset.page1', async () => {
      await repo.read.paginate({ page: 1, perPage: 20 })
    }),

    bench('offset.page50', async () => {
      await repo.read.paginate({ page: 50, perPage: 20 })
    }),

    bench('cursor.forward', async () => {
      const page1 = await repo.read.paginateCursor({ take: 20 })

      if (page1.nextCursor != null)
        await repo.read.paginateCursor({ take: 20, cursor: page1.nextCursor })
    }),
  ])
}
