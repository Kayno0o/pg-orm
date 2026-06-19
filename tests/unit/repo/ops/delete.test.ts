import { describe, expect, it } from 'bun:test'
import { defineTable, softDelete } from '../../../../src/index'
import { setupWritePipeline as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const soft = defineTable('soft', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
})).withTrait(softDelete())

describe('WritePipeline deleteMany', () => {
  it('rewrites DELETE to UPDATE when soft-delete is active', async () => {
    const { exec, pipeline } = setup(soft)

    exec.preset([])
    await pipeline.deleteMany(e => e.eq('id', 1))

    expect(exec.lastQuery!.sql).toMatch(/UPDATE "soft"/)
    expect(exec.lastQuery!.sql).toMatch(/"deletedAt" =/)
  })

  it('emits a real DELETE when no soft-delete trait', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([])
    await pipeline.deleteMany(e => e.eq('id', 1))

    expect(exec.lastQuery!.sql).toMatch(/DELETE FROM "users"/)
  })
})

describe('WritePipeline deleteOne', () => {
  it('returns first primary key or null by default', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1 }])
    expect(await pipeline.deleteOne(e => e.eq('id', 1))).toBe(1)

    exec.preset([])
    expect(await pipeline.deleteOne(e => e.eq('id', 1))).toBeNull()
  })

  it('returns the first full row with { full: true }', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, name: 'A' }])
    expect(await pipeline.deleteOne(e => e.eq('id', 1), { full: true })).toEqual({ id: 1, name: 'A' })
  })
})

describe('WritePipeline forceDelete', () => {
  it('emits a real DELETE even on a soft-delete table', async () => {
    const { exec, pipeline } = setup(soft)

    exec.preset([])
    await pipeline.forceDelete(e => e.eq('id', 1))

    expect(exec.lastQuery!.sql).toMatch(/DELETE FROM "soft"/)
  })
})

describe('WritePipeline restore', () => {
  it('throws when the table has no softDelete trait', async () => {
    const { pipeline } = setup(users)

    await expect(pipeline.restore(e => e.eq('id', 1))).rejects.toBeDefined()
  })

  it('sets the soft-delete column to NULL', async () => {
    const { exec, pipeline } = setup(soft)

    exec.preset([])
    await pipeline.restore(e => e.eq('id', 1))

    expect(exec.lastQuery!.sql).toMatch(/UPDATE "soft"/)
    expect(exec.lastQuery!.sql).toMatch(/"deletedAt" IS NOT NULL/)
  })
})
