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

describe('WritePipeline upsertOne', () => {
  it('returns the primary key by default', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1 }])
    const id = await pipeline.upsertOne({ email: 'a@x.com', name: 'A' }, ['email'])

    expect(id).toBe(1)
    expect(exec.lastQuery!.sql).toMatch(/INSERT INTO "users"/)
    expect(exec.lastQuery!.sql).toMatch(/ON CONFLICT/)
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns a single full row with { full: true }', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, email: 'a@x.com', name: 'A' }])
    const row = await pipeline.upsertOne({ email: 'a@x.com', name: 'A' }, ['email'], undefined, { full: true })

    expect(row).toEqual({ id: 1, email: 'a@x.com', name: 'A' })
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })

  it('restricts the update to the given columns', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1 }])
    await pipeline.upsertOne({ email: 'a@x.com', name: 'A' }, ['email'], ['name'])

    expect(exec.lastQuery!.sql).toMatch(/DO UPDATE SET "name" = EXCLUDED\."name"/)
    expect(exec.lastQuery!.sql).not.toMatch(/"email" = EXCLUDED/)
  })

  it('emits the same statement as the single-row upsertMany', async () => {
    const one = setup(users)
    const many = setup(users)

    one.exec.preset([{ id: 1 }])
    many.exec.preset([{ id: 1 }])
    await one.pipeline.upsertOne({ email: 'a@x.com', name: 'A' }, ['email'])
    await many.pipeline.upsertMany([{ email: 'a@x.com', name: 'A' }], ['email'])

    expect(one.exec.lastQuery!.sql).toBe(many.exec.lastQuery!.sql)
    expect(one.exec.lastQuery!.params).toEqual(many.exec.lastQuery!.params)
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
