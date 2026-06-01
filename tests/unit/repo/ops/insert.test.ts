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
  it('issues INSERT ... RETURNING "id" and returns the primary key by default', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 99 }])
    const id = await insertOne(exec, rt, { name: 'Alice' })

    expect(id).toBe(99)
    expect(exec.lastQuery!.sql).toMatch(/INSERT INTO "users"/)
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns the full inserted entity with { full: true }', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 99, name: 'Alice' }])
    const row = await insertOne(exec, rt, { name: 'Alice' }, { full: true })

    expect(row).toEqual({ id: 99, name: 'Alice' })
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })

  it('fires beforeInsert hook so payload can be mutated', async () => {
    const table = defineTable('hooked', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))

    table.hook('beforeInsert', (values: any) => ({ ...values, name: `${values.name}!` }))

    const { exec, rt } = setup(table)

    exec.preset([{ id: 1, name: 'Bob!' }])
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

  it('returns primary keys in row order by default', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 10 }, { id: 11 }, { id: 12 }])
    const ids = await insertMany(exec, rt, [{ name: 'A' }, { name: 'B' }, { name: 'C' }])

    expect(ids).toEqual([10, 11, 12])
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns full entities in row order with { full: true }', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 10, name: 'A' }, { id: 11, name: 'B' }, { id: 12, name: 'C' }])
    const rows = await insertMany(exec, rt, [{ name: 'A' }, { name: 'B' }, { name: 'C' }], { full: true })

    expect(rows).toEqual([{ id: 10, name: 'A' }, { id: 11, name: 'B' }, { id: 12, name: 'C' }])
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })
})
