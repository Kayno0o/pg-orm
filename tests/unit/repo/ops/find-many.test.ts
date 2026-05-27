import { describe, expect, it } from 'bun:test'
import { defineTable, softDelete } from '../../../../src/index'
import { findMany } from '../../../../src/repo/ops/find-many'
import { setupOpEnv as setup } from './_helpers'

const usersTable = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const softTable = defineTable('soft', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
})).withTrait(softDelete())

describe('findMany op', () => {
  it('runs a basic SELECT and returns rows', async () => {
    const { exec, rt, rel, map } = setup(usersTable)

    exec.preset([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])

    const rows = await findMany(exec, rt, rel, map, undefined, undefined)

    expect(rows).toEqual([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
    expect(exec.lastQuery!.sql).toContain('SELECT')
    expect(exec.lastQuery!.sql).toContain('FROM "users"')
  })

  it('applies pre-select soft-delete filter automatically', async () => {
    const { exec, rt, rel, map } = setup(softTable)

    exec.preset([])
    await findMany(exec, rt, rel, map, undefined, undefined)

    expect(exec.lastQuery!.sql).toMatch(/"deletedAt" IS NULL/)
  })

  it('applies defaultLimit when builder has no limit set', async () => {
    const { exec, rt, rel, map } = setup(usersTable)

    exec.preset([])
    await findMany(exec, rt, rel, map, undefined, 25)

    expect(exec.lastQuery!.sql).toMatch(/LIMIT \$1/)
    expect(exec.lastQuery!.params).toContain(25)
  })

  it('respects a callback-supplied limit over the default', async () => {
    const { exec, rt, rel, map } = setup(usersTable)

    exec.preset([])
    await findMany(exec, rt, rel, map, q => q.limit(7), 25)

    expect(exec.lastQuery!.params).toContain(7)
    expect(exec.lastQuery!.params).not.toContain(25)
  })
})
