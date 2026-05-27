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

  it('emits INSERT ... ON CONFLICT DO UPDATE RETURNING *', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1, email: 'a@x.com', name: 'A' }])
    const rows = await upsertMany(exec, rt, [{ email: 'a@x.com', name: 'A' }], ['email'])

    expect(rows).toHaveLength(1)
    expect(exec.lastQuery!.sql).toMatch(/INSERT INTO "users"/)
    expect(exec.lastQuery!.sql).toMatch(/ON CONFLICT/)
  })
})

describe('findOrCreate op', () => {
  it('returns a single row', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1, email: 'a@x.com', name: 'A' }])
    const row = await findOrCreate(exec, rt, { email: 'a@x.com', name: 'A' }, ['email'])

    expect(row).toEqual({ id: 1, email: 'a@x.com', name: 'A' })
    expect(exec.lastQuery!.sql).toMatch(/ON CONFLICT/)
  })
})
