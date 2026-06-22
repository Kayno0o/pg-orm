import { describe, expect, it } from 'bun:test'
import { NotFoundError } from '../../../../src/errors/index'
import { defineTable } from '../../../../src/index'
import { setupReadPipeline as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const composite = defineTable('composite', t => ({
  a: t.int4().notNull().primaryKey(),
  b: t.int4().notNull().primaryKey(),
}))

describe('findOne pipeline', () => {
  it('returns first row or null', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, name: 'A' }])
    expect(await pipeline.findOne()).toEqual({ id: 1, name: 'A' })
    expect(exec.lastQuery!.sql).toMatch(/LIMIT \$1/)
    expect(exec.lastQuery!.params).toEqual([1])

    exec.preset([])
    expect(await pipeline.findOne()).toBeNull()
  })
})

describe('findOneOrThrow pipeline', () => {
  it('throws NotFoundError when no row matches', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([])
    await expect(pipeline.findOneOrThrow()).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('findById pipeline', () => {
  it('builds composite-PK where clause when primaryKey is comma-separated', async () => {
    const { exec, pipeline } = setup(composite)

    exec.preset([])
    await pipeline.findById({ a: 1, b: 2 })

    expect(exec.lastQuery!.sql).toMatch(/"a" = \$/)
    expect(exec.lastQuery!.sql).toMatch(/"b" = \$/)
    expect(exec.lastQuery!.params).toEqual(expect.arrayContaining([1, 2]))
  })

  it('falls back to simple PK equality for single-column PK', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 42, name: 'X' }])
    const row = await pipeline.findById(42)

    expect(row).toEqual({ id: 42, name: 'X' })
    expect(exec.lastQuery!.params).toContain(42)
  })
})
