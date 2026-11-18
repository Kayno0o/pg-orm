import { describe, expect, it } from 'bun:test'
import { defineTable, optimisticLock, softDelete } from '../../../src/index'
import { setupWritePipeline } from './ops/_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  email: t.text().notNull().unique(),
  name: t.text().notNull(),
}))

const memberships = defineTable('memberships', t => ({
  userId: t.int4().notNull(),
  groupId: t.int4().notNull(),
  role: t.text().notNull(),
}))
const composite = { ...memberships, primaryKey: 'userId,groupId' } as unknown as typeof memberships

const guarded = defineTable('docs', t => ({
  id: t.serial().primaryKey(),
  tenant: t.text().notNull(),
  name: t.text().notNull(),
})).withScope('tenant', e => e.eq('tenant', 'acme')).withTrait(softDelete()).withTrait(optimisticLock())

const SUBQUERY = /IN \(SELECT/

describe('updateOne and deleteOne on a pinned key', () => {
  it('skips the subquery when the WHERE is a primary-key equality, object or callback', async () => {
    const { exec, pipeline } = setupWritePipeline(users)

    exec.preset([{ id: 3 }])
    await pipeline.updateOne({ name: 'Bob' }, { id: 3 } as never, { pk: true })
    expect(exec.lastQuery!.sql).toBe('UPDATE "users" SET "name" = $1 WHERE "id" = $2 RETURNING "id"')
    expect(exec.lastQuery!.params).toEqual(['Bob', 3])

    exec.preset([{ id: 3 }])
    await pipeline.deleteOne(e => e.eq('id', 3), { pk: true })
    expect(exec.lastQuery!.sql).toBe('DELETE FROM "users" WHERE "id" = $1 RETURNING "id"')
    expect(exec.lastQuery!.params).toEqual([3])
  })

  it('skips it for a single-column unique and for a pinned key with extra conditions', async () => {
    const { exec, pipeline } = setupWritePipeline(users)

    exec.preset([])
    await pipeline.updateOne({ name: 'Bob' }, { email: 'a@b.c' } as never, { pk: true })
    expect(exec.lastQuery!.sql).not.toMatch(SUBQUERY)

    exec.preset([])
    await pipeline.updateOne({ name: 'Bob' }, { id: 3, name: 'Al' } as never, { pk: true })
    expect(exec.lastQuery!.sql).toBe('UPDATE "users" SET "name" = $1 WHERE ("id" = $2 AND "name" = $3) RETURNING "id"')
  })

  it('skips it for a composite key held by every part, and keeps it for a part alone', async () => {
    const { exec, pipeline } = setupWritePipeline(composite)

    exec.preset([])
    await pipeline.deleteOne({ userId: 1, groupId: 2 } as never, { pk: true })
    expect(exec.lastQuery!.sql).not.toMatch(SUBQUERY)

    exec.preset([])
    await pipeline.deleteOne({ userId: 1 } as never, { pk: true })
    expect(exec.lastQuery!.sql).toMatch(SUBQUERY)
  })

  it('keeps the subquery whenever the key is not surely pinned', async () => {
    const { exec, pipeline } = setupWritePipeline(users)
    const cases = [
      { name: 'Al' },
      { id: null },
      { id: { gt: 1 } },
      { id: [1, 2] },
    ]

    for (const where of cases) {
      exec.preset([])
      await pipeline.deleteOne(where as never, { pk: true })
      expect(exec.lastQuery!.sql).toMatch(SUBQUERY)
    }

    exec.preset([])
    await pipeline.deleteOne(e => e.or(e.eq('id', 1), e.eq('id', 2)), { pk: true })
    expect(exec.lastQuery!.sql).toMatch(SUBQUERY)

    exec.preset([])
    await pipeline.deleteOne(e => e.and(e.eq('id', 1), e.or(e.eq('name', 'a'), e.eq('name', 'b'))), { pk: true })
    expect(exec.lastQuery!.sql).toMatch(SUBQUERY)
  })

  it('still carries scopes, the soft delete and the version bump without the subquery', async () => {
    const { exec, pipeline } = setupWritePipeline(guarded)

    exec.preset([])
    await pipeline.updateOne({ name: 'x' }, { id: 7 } as never, { pk: true })
    expect(exec.lastQuery!.sql).not.toMatch(SUBQUERY)
    expect(exec.lastQuery!.sql).toContain('"version" = "version" + 1')
    expect(exec.lastQuery!.sql).toContain('"tenant" = $')
    expect(exec.lastQuery!.sql).toContain('"deletedAt" IS NULL')

    exec.preset([])
    await pipeline.deleteOne({ id: 7 } as never, { pk: true })
    expect(exec.lastQuery!.sql).toMatch(/^UPDATE "docs" SET "deletedAt" = /)
    expect(exec.lastQuery!.sql).not.toMatch(SUBQUERY)
    expect(exec.lastQuery!.sql).toContain('"tenant" = $')

    exec.preset([])
    await pipeline.deleteOne({ id: 7 } as never, { pk: true, withoutScopes: ['tenant'] })
    expect(exec.lastQuery!.sql).not.toContain('"tenant"')
  })

  it('onMany: throw needs no count when the key is pinned', async () => {
    const { exec, pipeline } = setupWritePipeline(users)

    exec.preset([])
    expect(await pipeline.deleteOne({ id: 1 } as never, { pk: true, onMany: 'throw' })).toBeNull()
    expect(exec.queries).toHaveLength(1)
    expect(exec.lastQuery!.sql).toBe('DELETE FROM "users" WHERE "id" = $1 RETURNING "id"')
  })
})
