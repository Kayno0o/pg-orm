import { describe, expect, it } from 'bun:test'
import { defineTable, isTableDef, softDelete } from '../../../src/index'

describe('isTableDef', () => {
  const users = defineTable('itd_users', t => ({ id: t.serial().primaryKey() }))

  it('accepts a defined table, with or without traits', () => {
    expect(isTableDef(users)).toBe(true)
    expect(isTableDef(defineTable('itd_posts', t => ({ id: t.serial().primaryKey() })).withTrait(softDelete()))).toBe(true)
  })

  it('rejects look-alikes and other values', () => {
    const lookalike = { ...users, withTrait: users.withTrait, primaryKey: 'id' }

    for (const value of [lookalike, { name: 'x', columns: {}, primaryKey: 'id' }, null, undefined, 'users', 1, () => users])
      expect(isTableDef(value)).toBe(false)
  })

  it('narrows to a table definition', () => {
    const value: unknown = users

    if (isTableDef(value))
      expect(value.name).toBe('itd_users')
  })
})
