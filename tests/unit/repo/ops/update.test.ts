import { describe, expect, it } from 'bun:test'
import { StaleRecordError, ValidationError } from '../../../../src/errors/index'
import { defineTable, optimisticLock } from '../../../../src/index'
import { updateMany, updateOne } from '../../../../src/repo/ops/update-many'
import { updateWithLock } from '../../../../src/repo/ops/update-with-lock'
import { setupOpEnv as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const versioned = defineTable('versioned', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
})).withTrait(optimisticLock())

describe('updateMany op', () => {
  it('issues UPDATE ... WHERE ... RETURNING "id" and returns primary keys by default', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1 }])
    const ids = await updateMany(exec, rt, { name: 'New' }, e => e.eq('id', 1))

    expect(ids).toEqual([1])
    expect(exec.lastQuery!.sql).toMatch(/UPDATE "users"/)
    expect(exec.lastQuery!.sql).toMatch(/RETURNING "id"/)
  })

  it('returns full rows with { full: true }', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1, name: 'New' }])
    const rows = await updateMany(exec, rt, { name: 'New' }, e => e.eq('id', 1), { full: true })

    expect(rows).toEqual([{ id: 1, name: 'New' }])
    expect(exec.lastQuery!.sql).toMatch(/RETURNING \*/)
  })

  it('applies optimistic-lock version bump via setRaw', async () => {
    const { exec, rt } = setup(versioned)

    exec.preset([])
    await updateMany(exec, rt, { name: 'X' }, e => e.eq('id', 1))

    expect(exec.lastQuery!.sql).toMatch(/"version" = "version" \+ 1/)
  })
})

describe('updateOne op', () => {
  it('returns first primary key or null by default', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1 }, { id: 2 }])
    expect(await updateOne(exec, rt, { name: 'X' }, e => e.eq('id', 1))).toBe(1)

    exec.preset([])
    expect(await updateOne(exec, rt, { name: 'X' }, e => e.eq('id', 1))).toBeNull()
  })

  it('returns the first full row with { full: true }', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
    expect(await updateOne(exec, rt, { name: 'X' }, e => e.eq('id', 1), { full: true })).toEqual({ id: 1, name: 'A' })
  })
})

describe('updateWithLock op', () => {
  it('throws ValidationError when the table has no optimisticLock trait', async () => {
    const { exec, rt } = setup(users)

    await expect(updateWithLock(exec, rt, { name: 'X' }, e => e.eq('id', 1), 1))
      .rejects
      .toBeInstanceOf(ValidationError)
  })

  it('throws StaleRecordError when no rows match the version predicate', async () => {
    const { exec, rt } = setup(versioned)

    exec.preset([])
    await expect(updateWithLock(exec, rt, { name: 'X' }, e => e.eq('id', 1), 3))
      .rejects
      .toBeInstanceOf(StaleRecordError)
  })

  it('returns the primary key when version matches by default', async () => {
    const { exec, rt } = setup(versioned)

    exec.preset([{ id: 1 }])
    const id = await updateWithLock(exec, rt, { name: 'X' }, e => e.eq('id', 1), 3)

    expect(id).toBe(1)
  })

  it('returns the updated row when version matches with { full: true }', async () => {
    const { exec, rt } = setup(versioned)

    exec.preset([{ id: 1, name: 'X', version: 4 }])
    const row = await updateWithLock(exec, rt, { name: 'X' }, e => e.eq('id', 1), 3, { full: true })

    expect(row).toEqual({ id: 1, name: 'X', version: 4 })
  })
})
