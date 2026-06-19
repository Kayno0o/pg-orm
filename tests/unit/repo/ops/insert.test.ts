import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../../src/index'
import { setupWritePipeline as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

describe('WritePipeline insertOne', () => {
  it('issues INSERT ... RETURNING "id" and returns the primary key by default', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 99 }])
    const id = await pipeline.insertOne({ name: 'Alice' })

    expect(id).toBe(99)
    expect(exec.lastQuery!.sql).toMatch(/INSERT INTO "users"/)
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns the full inserted entity with { full: true }', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 99, name: 'Alice' }])
    const row = await pipeline.insertOne({ name: 'Alice' }, { full: true })

    expect(row).toEqual({ id: 99, name: 'Alice' })
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })

  it('fires beforeInsert hook so payload can be mutated', async () => {
    const table = defineTable('hooked', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))

    table.hook('beforeInsert', (values: any) => ({ ...values, name: `${values.name}!` }))

    const { exec, pipeline } = setup(table)

    exec.preset([{ id: 1, name: 'Bob!' }])
    await pipeline.insertOne({ name: 'Bob' })

    expect(exec.lastQuery!.params).toContain('Bob!')
  })

  it('emits DEFAULT VALUES for an empty object (all columns take their default)', async () => {
    const defaults = defineTable('defaults', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull().default('anon'),
    }))
    const { exec, pipeline } = setup(defaults)

    exec.preset([{ id: 7 }])
    const id = await pipeline.insertOne({})

    expect(id).toBe(7)
    // `() VALUES ()` is a Postgres syntax error — must be `DEFAULT VALUES`.
    expect(exec.lastQuery!.sql).toMatch(/INSERT INTO "defaults" DEFAULT VALUES/)
    expect(exec.lastQuery!.sql).not.toMatch(/\(\)\s*VALUES\s*\(\)/)
    expect(exec.lastQuery!.params).toHaveLength(0)
  })
})

describe('WritePipeline insertMany', () => {
  it('short-circuits on empty array without issuing a query', async () => {
    const { exec, pipeline } = setup(users)

    const result = await pipeline.insertMany([])

    expect(result).toEqual([])
    expect(exec.queries).toHaveLength(0)
  })

  it('returns primary keys in row order by default', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 10 }, { id: 11 }, { id: 12 }])
    const ids = await pipeline.insertMany([{ name: 'A' }, { name: 'B' }, { name: 'C' }])

    expect(ids).toEqual([10, 11, 12])
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns full entities in row order with { full: true }', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 10, name: 'A' }, { id: 11, name: 'B' }, { id: 12, name: 'C' }])
    const rows = await pipeline.insertMany([{ name: 'A' }, { name: 'B' }, { name: 'C' }], { full: true })

    expect(rows).toEqual([{ id: 10, name: 'A' }, { id: 11, name: 'B' }, { id: 12, name: 'C' }])
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })
})
