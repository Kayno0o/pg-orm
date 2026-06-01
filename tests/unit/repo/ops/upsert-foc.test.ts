import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../../src/index'
import { findOrCreate } from '../../../../src/repo/ops/find-or-create'
import { upsertMany } from '../../../../src/repo/ops/upsert'
import { setupOpEnv as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  email: t.text().notNull(),
  name: t.text().notNull(),
}))

describe('upsertMany op', () => {
  it('short-circuits on empty values without issuing a query', async () => {
    const { exec, rt } = setup(users)

    const result = await upsertMany(exec, rt, [], ['email'])

    expect(result).toEqual([])
    expect(exec.queries).toHaveLength(0)
  })

  it('emits INSERT ... ON CONFLICT DO UPDATE and returns primary keys by default', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1 }])
    const ids = await upsertMany(exec, rt, [{ email: 'a@x.com', name: 'A' }], ['email'])

    expect(ids).toEqual([1])
    expect(exec.lastQuery!.sql).toMatch(/INSERT INTO "users"/)
    expect(exec.lastQuery!.sql).toMatch(/ON CONFLICT/)
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns full rows with { full: true }', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1, email: 'a@x.com', name: 'A' }])
    const rows = await upsertMany(exec, rt, [{ email: 'a@x.com', name: 'A' }], ['email'], undefined, { full: true })

    expect(rows).toEqual([{ id: 1, email: 'a@x.com', name: 'A' }])
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })
})

describe('findOrCreate op', () => {
  it('returns the primary key by default', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1 }])
    const id = await findOrCreate(exec, rt, { email: 'a@x.com', name: 'A' }, ['email'])

    expect(id).toBe(1)
    expect(exec.lastQuery!.sql).toMatch(/ON CONFLICT/)
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns a single full row with { full: true }', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1, email: 'a@x.com', name: 'A' }])
    const row = await findOrCreate(exec, rt, { email: 'a@x.com', name: 'A' }, ['email'], { full: true })

    expect(row).toEqual({ id: 1, email: 'a@x.com', name: 'A' })
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })
})
