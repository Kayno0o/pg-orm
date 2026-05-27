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
  it('issues UPDATE ... WHERE ... RETURNING * and returns rows', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1, name: 'New' }])
    const rows = await updateMany(exec, rt, { name: 'New' }, e => e.eq('id', 1))

    expect(rows).toEqual([{ id: 1, name: 'New' }])
    expect(exec.lastQuery!.sql).toMatch(/UPDATE "users"/)
  })

  it('applies optimistic-lock version bump via setRaw', async () => {
    const { exec, rt } = setup(versioned)

    exec.preset([])
    await updateMany(exec, rt, { name: 'X' }, e => e.eq('id', 1))

    expect(exec.lastQuery!.sql).toMatch(/"version" = "version" \+ 1/)
  })
})

describe('updateOne op', () => {
  it('returns first row or null', async () => {
    const { exec, rt } = setup(users)

    exec.preset([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
    expect(await updateOne(exec, rt, { name: 'X' }, e => e.eq('id', 1))).toEqual({ id: 1, name: 'A' })

    exec.preset([])
    expect(await updateOne(exec, rt, { name: 'X' }, e => e.eq('id', 1))).toBeNull()
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

  it('returns the updated row when version matches', async () => {
    const { exec, rt } = setup(versioned)

    exec.preset([{ id: 1, name: 'X', version: 4 }])
    const row = await updateWithLock(exec, rt, { name: 'X' }, e => e.eq('id', 1), 3)

    expect(row).toEqual({ id: 1, name: 'X', version: 4 })
  })
})
