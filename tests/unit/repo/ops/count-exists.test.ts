import { describe, expect, it } from 'bun:test'
import { defineTable, softDelete } from '../../../../src/index'
import { setupReadPipeline as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const soft = defineTable('soft', t => ({
  id: t.serial().primaryKey(),
})).withTrait(softDelete())

describe('count pipeline', () => {
  it('returns numeric count from first row', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ count: '42' }])
    expect(await pipeline.count()).toBe(42)
    expect(exec.lastQuery!.sql).toMatch(/count\(\*\)/i)
  })

  it('returns 0 when no count row is returned', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([])
    expect(await pipeline.count()).toBe(0)
  })

  it('applies soft-delete filter automatically', async () => {
    const { exec, pipeline } = setup(soft)

    exec.preset([{ count: '0' }])
    await pipeline.count()
    expect(exec.lastQuery!.sql).toMatch(/"deletedAt" IS NULL/)
  })
})

describe('exists pipeline', () => {
  it('returns true when any row matches', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ exists: true }])
    expect(await pipeline.exists(e => e.eq('id', 1))).toBe(true)
  })

  it('returns false when no row matches', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([])
    expect(await pipeline.exists(e => e.eq('id', 1))).toBe(false)
  })
})
