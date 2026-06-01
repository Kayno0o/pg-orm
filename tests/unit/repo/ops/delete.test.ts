import { describe, expect, it } from 'bun:test'
import { defineTable, softDelete } from '../../../../src/index'
import { deleteMany, deleteOne } from '../../../../src/repo/ops/delete-many'
import { forceDelete } from '../../../../src/repo/ops/force-delete'
import { restore } from '../../../../src/repo/ops/restore'
import { setupOpEnv as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const soft = defineTable('soft', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
})).withTrait(softDelete())

describe('deleteMany op', () => {
  it('rewrites DELETE to UPDATE when soft-delete is active', async () => {
    const { exec, rt } = setup(soft)

    exec.preset([])
    await deleteMany(exec, rt, e => e.eq('id', 1))

    expect(exec.lastQuery!.sql).toMatch(/UPDATE "soft"/)
    expect(exec.lastQuery!.sql).toMatch(/"deletedAt" =/)
  })

  it('emits a real DELETE when no soft-delete trait', async () => {
    const { exec, rt } = setup(users)

    exec.preset([])
    await deleteMany(exec, rt, e => e.eq('id', 1))

    expect(exec.lastQuery!.sql).toMatch(/DELETE FROM "users"/)
  })
})

describe('deleteOne op', () => {
  it('returns first primary key or null by default', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1 }])
    expect(await deleteOne(exec, rt, e => e.eq('id', 1))).toBe(1)

    exec.preset([])
    expect(await deleteOne(exec, rt, e => e.eq('id', 1))).toBeNull()
  })

  it('returns the first full row with { full: true }', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1, name: 'A' }])
    expect(await deleteOne(exec, rt, e => e.eq('id', 1), { full: true })).toEqual({ id: 1, name: 'A' })
  })
})

describe('forceDelete op', () => {
  it('emits a real DELETE even on a soft-delete table', async () => {
    const { exec, rt } = setup(soft)

    exec.preset([])
    await forceDelete(exec, rt, e => e.eq('id', 1))

    expect(exec.lastQuery!.sql).toMatch(/DELETE FROM "soft"/)
  })
})

describe('restore op', () => {
  it('throws when the table has no softDelete trait', async () => {
    const { exec, rt } = setup(users)

    await expect(restore(exec, rt, e => e.eq('id', 1))).rejects.toBeDefined()
  })

  it('sets the soft-delete column to NULL', async () => {
    const { exec, rt } = setup(soft)

    exec.preset([])
    await restore(exec, rt, e => e.eq('id', 1))

    expect(exec.lastQuery!.sql).toMatch(/UPDATE "soft"/)
    expect(exec.lastQuery!.sql).toMatch(/"deletedAt" IS NOT NULL/)
  })
})
