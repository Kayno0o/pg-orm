import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../../src/index'
import { setupReadPipeline as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

describe('paginate pipeline', () => {
  it('returns data + totals derived from two queries', async () => {
    const { exec, pipeline } = setup(users)

    // Order of preset: findMany then count both run in Promise.all; the first call
    // to executor.query receives whichever the scheduler picks. We seed both rows
    // and total identically so the test is order-independent.
    exec.preset([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
    exec.preset([{ count: '7' }])

    const result = await pipeline.paginate({ page: 2, perPage: 2 })

    expect(result.page).toBe(2)
    expect(result.perPage).toBe(2)
    expect(result.total).toBe(7)
    expect(result.totalPages).toBe(Math.ceil(7 / 2))
    expect(result.data).toHaveLength(2)
  })
})

describe('paginateCursor pipeline', () => {
  it('drops the take+1 sentinel row and exposes nextCursor', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
      { id: 3, name: 'C' }, // take=2 returns 3 rows so hasMore is true
    ])

    const result = await pipeline.paginateCursor({ take: 2 })

    expect(result.data).toHaveLength(2)
    expect(result.nextCursor).toBe(2)
  })

  it('returns null nextCursor when result count <= take', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, name: 'A' }])
    const result = await pipeline.paginateCursor({ take: 5 })

    expect(result.nextCursor).toBeNull()
  })
})
