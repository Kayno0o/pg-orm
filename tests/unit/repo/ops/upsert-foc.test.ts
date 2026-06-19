import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../../src/index'
import { setupWritePipeline as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  email: t.text().notNull(),
  name: t.text().notNull(),
}))

describe('WritePipeline upsertMany', () => {
  it('short-circuits on empty values without issuing a query', async () => {
    const { exec, pipeline } = setup(users)

    const result = await pipeline.upsertMany([], ['email'])

    expect(result).toEqual([])
    expect(exec.queries).toHaveLength(0)
  })

  it('emits INSERT ... ON CONFLICT DO UPDATE and returns primary keys by default', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1 }])
    const ids = await pipeline.upsertMany([{ email: 'a@x.com', name: 'A' }], ['email'])

    expect(ids).toEqual([1])
    expect(exec.lastQuery!.sql).toMatch(/INSERT INTO "users"/)
    expect(exec.lastQuery!.sql).toMatch(/ON CONFLICT/)
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns full rows with { full: true }', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, email: 'a@x.com', name: 'A' }])
    const rows = await pipeline.upsertMany([{ email: 'a@x.com', name: 'A' }], ['email'], undefined, { full: true })

    expect(rows).toEqual([{ id: 1, email: 'a@x.com', name: 'A' }])
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })
})

describe('WritePipeline findOrCreate', () => {
  it('returns the primary key by default', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1 }])
    const id = await pipeline.findOrCreate({ email: 'a@x.com', name: 'A' }, ['email'])

    expect(id).toBe(1)
    expect(exec.lastQuery!.sql).toMatch(/ON CONFLICT/)
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns a single full row with { full: true }', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, email: 'a@x.com', name: 'A' }])
    const row = await pipeline.findOrCreate({ email: 'a@x.com', name: 'A' }, ['email'], { full: true })

    expect(row).toEqual({ id: 1, email: 'a@x.com', name: 'A' })
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })
})
