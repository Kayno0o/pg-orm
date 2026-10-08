import { describe, expect, it } from 'bun:test'
import { ValidationError } from '../../../src/errors/index'
import { defineTable, softDelete } from '../../../src/index'
import { setupReadPipeline } from './ops/_helpers'

const articles = defineTable('articles', t => ({
  id: t.serial().primaryKey(),
  title: t.text().notNull(),
  published: t.boolean().notNull(),
})).withTrait(softDelete())

describe('paginate', () => {
  it('reads the page and its total in one query, a window counting every matched row', async () => {
    const { exec, pipeline } = setupReadPipeline(articles)

    exec.preset([{ id: 1, title: 'a', published: true, __pgorm_total: 12 }])

    const result = await pipeline.paginate({ page: 2, perPage: 5, where: { published: true } })

    expect(exec.queries).toHaveLength(1)
    expect(exec.queries[0]!.sql).toContain('CAST(count(*) OVER () AS double precision) AS "__pgorm_total"')
    expect(exec.queries[0]!.sql).toContain('WHERE ("published" = $1 AND "deletedAt" IS NULL)')
    expect(exec.queries[0]!.sql).toContain('LIMIT')
    expect(Object.keys(result.data[0]!)).not.toContain('__pgorm_total')
    expect(result.total).toBe(12)
    expect(result.page).toBe(2)
    expect(result.totalPages).toBe(3)
  })

  it('counts on its own only for an empty page past the first, off the same filters', async () => {
    const { exec, pipeline } = setupReadPipeline(articles)

    exec.preset([])
    exec.preset([{ count: 4 }])

    const result = await pipeline.paginate({ page: 3, perPage: 10 }, q => q.pick('id').where({ published: false }).orderBy('id', 'desc'))
    const [rows, counted] = exec.queries

    expect(rows!.sql).toContain('SELECT "id"')
    expect(counted!.sql).toContain('SELECT count(*)')
    expect(counted!.sql).toContain('"published" = $1')
    expect(counted!.sql).not.toContain('ORDER BY')
    expect(counted!.sql).not.toContain('LIMIT')
    expect(result.total).toBe(4)
  })

  it('knows an empty first page holds nothing, and keeps a separate count for a DISTINCT query', async () => {
    const { exec, pipeline } = setupReadPipeline(articles)

    exec.preset([])
    expect((await pipeline.paginate({ page: 1, perPage: 10 })).total).toBe(0)
    expect(exec.queries).toHaveLength(1)

    exec.preset([{ title: 'a' }])
    exec.preset([{ count: 1 }])
    await pipeline.paginate({ page: 1, perPage: 10 }, q => q.pick('title').distinct())

    expect(exec.queries).toHaveLength(3)
    expect(exec.queries[1]!.sql).not.toContain('OVER')
  })

  it('includes trashed rows in both queries when asked', async () => {
    const { exec, pipeline } = setupReadPipeline(articles)

    exec.preset([])
    exec.preset([{ count: 0 }])

    await pipeline.paginate({ page: 1, perPage: 10, withTrashed: true })

    for (const query of exec.queries)
      expect(query.sql).not.toContain('deletedAt')
  })

  it('rejects a page or perPage below one', async () => {
    const { pipeline } = setupReadPipeline(articles)

    expect(pipeline.paginate({ page: 0, perPage: 10 })).rejects.toThrow(ValidationError)
    expect(pipeline.paginate({ page: 1, perPage: 0 })).rejects.toThrow(ValidationError)
  })
})

describe('count and exists', () => {
  it('excludes trashed rows by default and includes them on request', async () => {
    const { exec, pipeline } = setupReadPipeline(articles)

    exec.preset([{ count: 1 }])
    await pipeline.count()

    expect(exec.lastQuery!.sql).toContain('"deletedAt" IS NULL')

    exec.preset([{ count: 1 }])
    await pipeline.count(undefined, { withTrashed: true })

    expect(exec.lastQuery!.sql).not.toContain('deletedAt')
  })

  it('takes the object where shorthand', async () => {
    const { exec, pipeline } = setupReadPipeline(articles)

    exec.preset([{ count: 2 }])

    expect(await pipeline.count({ published: true })).toBe(2)
    expect(exec.lastQuery!.params).toEqual([true])
  })

  it('exists runs with no predicate at all', async () => {
    const { exec, pipeline } = setupReadPipeline(articles)

    exec.preset([{ _exists: 1 }])

    expect(await pipeline.exists()).toBe(true)
    expect(exec.lastQuery!.sql).toContain('SELECT 1 AS "_exists"')
  })
})
