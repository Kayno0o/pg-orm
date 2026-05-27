import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../../src/index'
import { insertMany } from '../../../../src/repo/ops/insert-many'
import { insertOne } from '../../../../src/repo/ops/insert-one'
import { setupOpEnv as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

describe('insertOne op', () => {
  it('issues INSERT ... RETURNING <pk> and returns the inserted PK', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 99 }])
    const id = await insertOne(exec, rt, { name: 'Alice' })

    expect(id).toBe(99)
    expect(exec.lastQuery!.sql).toMatch(/INSERT INTO "users"/)
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('fires beforeInsert hook so payload can be mutated', async () => {
    const table = defineTable('hooked', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))

    table.hook('beforeInsert', (values: any) => ({ ...values, name: `${values.name}!` }))

    const { exec, rt } = setup(table)

    exec.preset([{ id: 1 }])
    await insertOne(exec, rt, { name: 'Bob' })

    expect(exec.lastQuery!.params).toContain('Bob!')
  })
})

describe('insertMany op', () => {
  it('short-circuits on empty array without issuing a query', async () => {
    const { exec, rt } = setup(users)

    const result = await insertMany(exec, rt, [])

    expect(result).toEqual([])
    expect(exec.queries).toHaveLength(0)
  })

  it('returns PKs in row order', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 10 }, { id: 11 }, { id: 12 }])
    const ids = await insertMany(exec, rt, [{ name: 'A' }, { name: 'B' }, { name: 'C' }])

    expect(ids).toEqual([10, 11, 12])
  })
})
