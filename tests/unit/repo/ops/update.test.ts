import { describe, expect, it } from 'bun:test'
import { StaleRecordError, ValidationError } from '../../../../src/errors/index'
import { defineTable, optimisticLock } from '../../../../src/index'
import { setupWritePipeline as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const versioned = defineTable('versioned', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
})).withTrait(optimisticLock())

describe('WritePipeline updateMany', () => {
  it('issues UPDATE ... WHERE ... RETURNING "id" and returns primary keys by default', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1 }])
    const ids = await pipeline.updateMany({ name: 'New' }, e => e.eq('id', 1), { pk: true })

    expect(ids).toEqual([1])
    expect(exec.lastQuery!.sql).toMatch(/UPDATE "users"/)
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns full rows with { full: true }', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, name: 'New' }])
    const rows = await pipeline.updateMany({ name: 'New' }, e => e.eq('id', 1))

    expect(rows).toEqual([{ id: 1, name: 'New' }])
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })

  it('applies optimistic-lock version bump via setRaw', async () => {
    const { exec, pipeline } = setup(versioned)

    exec.preset([])
    await pipeline.updateMany({ name: 'X' }, e => e.eq('id', 1), { pk: true })

    expect(exec.lastQuery!.sql).toMatch(/"version" = "version" \+ 1/)
  })
})

describe('WritePipeline updateOne', () => {
  it('returns first primary key or null by default', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1 }, { id: 2 }])
    expect(await pipeline.updateOne({ name: 'X' }, e => e.eq('id', 1), { pk: true })).toBe(1)

    exec.preset([])
    expect(await pipeline.updateOne({ name: 'X' }, e => e.eq('id', 1), { pk: true })).toBeNull()
  })

  it('returns the first full row with { full: true }', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
    expect(await pipeline.updateOne({ name: 'X' }, e => e.eq('id', 1))).toEqual({ id: 1, name: 'A' })
  })
})

describe('WritePipeline updateWithLock', () => {
  it('throws ValidationError when the table has no optimisticLock trait', async () => {
    const { pipeline } = setup(users)

    await expect(pipeline.updateWithLock({ name: 'X' }, e => e.eq('id', 1), 1, { pk: true }))
      .rejects
      .toBeInstanceOf(ValidationError)
  })

  it('throws StaleRecordError when no rows match the version predicate', async () => {
    const { exec, pipeline } = setup(versioned)

    exec.preset([])
    await expect(pipeline.updateWithLock({ name: 'X' }, e => e.eq('id', 1), 3, { pk: true }))
      .rejects
      .toBeInstanceOf(StaleRecordError)
  })

  it('returns the primary key when version matches by default', async () => {
    const { exec, pipeline } = setup(versioned)

    exec.preset([{ id: 1 }])
    const id = await pipeline.updateWithLock({ name: 'X' }, e => e.eq('id', 1), 3, { pk: true })

    expect(id).toBe(1)
  })

  it('returns the updated row when version matches with { full: true }', async () => {
    const { exec, pipeline } = setup(versioned)

    exec.preset([{ id: 1, name: 'X', version: 4 }])
    const row = await pipeline.updateWithLock({ name: 'X' }, e => e.eq('id', 1), 3)

    expect(row).toEqual({ id: 1, name: 'X', version: 4 })
  })
})
