import { describe, expect, it } from 'bun:test'
import { NotFoundError } from '../../../../src/errors/index'
import { defineTable } from '../../../../src/index'
import { findById, findOne, findOneOrThrow } from '../../../../src/repo/ops/find-one'
import { setupOpEnv as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const composite = defineTable('composite', t => ({
  a: t.int4().notNull().primaryKey(),
  b: t.int4().notNull().primaryKey(),
}))

describe('findOne op', () => {
  it('returns first row or null', async () => {
    const { exec, rt, rel, map } = setup(users)

    exec.preset([{ id: 1, name: 'A' }])
    expect(await findOne(exec, rt, rel, map, undefined)).toEqual({ id: 1, name: 'A' })
    expect(exec.lastQuery!.sql).toMatch(/LIMIT \$1/)
    expect(exec.lastQuery!.params).toEqual([1])

    exec.preset([])
    expect(await findOne(exec, rt, rel, map, undefined)).toBeNull()
  })
})

describe('findOneOrThrow op', () => {
  it('throws NotFoundError when no row matches', async () => {
    const { exec, rt, rel, map } = setup(users)

    exec.preset([])
    await expect(findOneOrThrow(exec, rt, rel, map, undefined)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('findById op', () => {
  it('builds composite-PK where clause when primaryKey is comma-separated', async () => {
    const { exec, rt, rel, map } = setup(composite)

    exec.preset([])
    await findById(exec, rt, rel, map, { a: 1, b: 2 })

    expect(exec.lastQuery!.sql).toMatch(/"a" = \$/)
    expect(exec.lastQuery!.sql).toMatch(/"b" = \$/)
    expect(exec.lastQuery!.params).toEqual(expect.arrayContaining([1, 2]))
  })

  it('falls back to simple PK equality for single-column PK', async () => {
    const { exec, rt, rel, map } = setup(users)

    exec.preset([{ id: 42, name: 'X' }])
    const row = await findById(exec, rt, rel, map, 42)

    expect(row).toEqual({ id: 42, name: 'X' })
    expect(exec.lastQuery!.params).toContain(42)
  })
})
