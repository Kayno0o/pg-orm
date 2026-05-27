import { describe, expect, it } from 'bun:test'
import { defineTable, softDelete } from '../../../../src/index'
import { count } from '../../../../src/repo/ops/count'
import { exists } from '../../../../src/repo/ops/exists'
import { setupOpEnv as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const soft = defineTable('soft', t => ({
  id: t.serial().primaryKey(),
})).withTrait(softDelete())

describe('count op', () => {
  it('returns numeric count from first row', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ count: '42' }])
    expect(await count(exec, rt, undefined)).toBe(42)
    expect(exec.lastQuery!.sql).toMatch(/count\(\*\)/i)
  })

  it('returns 0 when no count row is returned', async () => {
    const { exec, rt } = setup(users)

    exec.preset([])
    expect(await count(exec, rt, undefined)).toBe(0)
  })

  it('applies soft-delete filter automatically', async () => {
    const { exec, rt } = setup(soft)

    exec.preset([{ count: '0' }])
    await count(exec, rt, undefined)
    expect(exec.lastQuery!.sql).toMatch(/"deletedAt" IS NULL/)
  })
})

describe('exists op', () => {
  it('returns true when any row matches', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ exists: true }])
    expect(await exists(exec, rt, e => e.eq('id', 1))).toBe(true)
  })

  it('returns false when no row matches', async () => {
    const { exec, rt } = setup(users)

    exec.preset([])
    expect(await exists(exec, rt, e => e.eq('id', 1))).toBe(false)
  })
})
