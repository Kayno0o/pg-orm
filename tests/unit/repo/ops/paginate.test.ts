import { describe, expect, it } from 'bun:test'
import { defineTable, ValidationError } from '../../../../src/index'
import { setupReadPipeline as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

describe('paginate pipeline', () => {
  it('returns data + totals from the page query', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, name: 'A', __pgorm_total: 7 }, { id: 2, name: 'B', __pgorm_total: 7 }])

    const result = await pipeline.paginate({ page: 2, perPage: 2 })

    expect(result.page).toBe(2)
    expect(result.perPage).toBe(2)
    expect(result.total).toBe(7)
    expect(result.totalPages).toBe(Math.ceil(7 / 2))
    expect(result.data).toHaveLength(2)
  })

  it('orders an unordered page by the primary key, so pages are disjoint', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([])
    await pipeline.paginate({ page: 1, perPage: 2 })

    expect(exec.queries[0]!.sql).toContain('ORDER BY "id" ASC LIMIT')
  })
})

describe('paginateCursor pipeline', () => {
  it('refuses a cursor that is not the shape its pages return', async () => {
    const { pipeline } = setup(users)

    for (const cursor of [{}, [1], { id: 1 }, { value: 1 }])
      await expect(pipeline.paginateCursor({ take: 2, cursor: cursor as never })).rejects.toBeInstanceOf(ValidationError)

    for (const cursor of [{ value: null, key: 1 }, { value: 'a' }, 7])
      await expect(pipeline.paginateCursor({ take: 2, cursor: cursor as never, column: 'name' })).rejects.toBeInstanceOf(ValidationError)
  })

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
