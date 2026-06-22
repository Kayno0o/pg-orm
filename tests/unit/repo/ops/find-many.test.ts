import { describe, expect, it } from 'bun:test'
import { defineTable, softDelete } from '../../../../src/index'
import { setupReadPipeline as setup } from './_helpers'

const usersTable = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const softTable = defineTable('soft', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
})).withTrait(softDelete())

describe('findMany pipeline', () => {
  it('runs a basic SELECT and returns rows', async () => {
    const { exec, pipeline } = setup(usersTable)

    exec.preset([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])

    const rows = await pipeline.findMany()

    expect(rows).toEqual([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
    expect(exec.lastQuery!.sql).toContain('SELECT')
    expect(exec.lastQuery!.sql).toContain('FROM "users"')
  })

  it('applies pre-select soft-delete filter automatically', async () => {
    const { exec, pipeline } = setup(softTable)

    exec.preset([])
    await pipeline.findMany()

    expect(exec.lastQuery!.sql).toMatch(/"deletedAt" IS NULL/)
  })

  it('applies defaultLimit when builder has no limit set', async () => {
    const { exec, pipeline } = setup(usersTable)

    exec.preset([])
    await pipeline.findMany(undefined, { defaultLimit: 25 })

    expect(exec.lastQuery!.sql).toMatch(/LIMIT \$1/)
    expect(exec.lastQuery!.params).toContain(25)
  })

  it('respects a callback-supplied limit over the default', async () => {
    const { exec, pipeline } = setup(usersTable)

    exec.preset([])
    await pipeline.findMany(q => q.limit(7), { defaultLimit: 25 })

    expect(exec.lastQuery!.params).toContain(7)
    expect(exec.lastQuery!.params).not.toContain(25)
  })
})
