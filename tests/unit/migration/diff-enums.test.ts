import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../src/index'
import { collectEnumRequirements, diffEnums } from '../../../src/migration/diff/enums'

function registry(...tables: any[]) {
  return new Map(tables.map(t => [t.name, t]))
}

describe('collectEnumRequirements', () => {
  it('collects enum names, values, and usages from desired tables', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('user_status', ['active', 'inactive'] as const).notNull(),
    }))
    const { neededEnums, enumUsages } = collectEnumRequirements(registry(table))

    expect(neededEnums.get('user_status')).toEqual(['active', 'inactive'])
    expect(enumUsages.get('user_status')).toEqual([{ table: 'users', column: 'status' }])
  })

  it('returns empty maps when no enums are used', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))
    const { neededEnums, enumUsages } = collectEnumRequirements(registry(table))

    expect(neededEnums.size).toBe(0)
    expect(enumUsages.size).toBe(0)
  })
})

describe('diffEnums', () => {
  it('creates missing enum', () => {
    const ops = diffEnums(
      new Map([['user_status', ['active', 'inactive']]]),
      new Map([['user_status', []]]),
      [],
    )

    expect(ops).toHaveLength(1)
    expect(ops[0]!.type).toBe('create_enum')
    expect(ops[0]!.sql).toContain('CREATE TYPE "user_status"')
    expect(ops[0]!.sql).toContain('active')
  })

  it('adds missing enum values', () => {
    const ops = diffEnums(
      new Map([['user_status', ['active', 'inactive', 'banned']]]),
      new Map([['user_status', []]]),
      [{ name: 'user_status', values: ['active', 'inactive'] }],
    )

    expect(ops).toHaveLength(1)
    expect(ops[0]!.type).toBe('alter_enum_add')
    expect(ops[0]!.sql).toContain('ADD VALUE IF NOT EXISTS')
    expect(ops[0]!.sql).toContain('banned')
  })

  it('recreates enum when values are removed', () => {
    const ops = diffEnums(
      new Map([['user_status', ['active']]]),
      new Map([['user_status', [{ table: 'users', column: 'status' }]]]),
      [{ name: 'user_status', values: ['active', 'inactive'] }],
    )

    expect(ops.length).toBeGreaterThanOrEqual(3)
    expect(ops.every(o => o.type === 'alter_enum_remove')).toBe(true)
    expect(ops.every(o => o.destructive)).toBe(true)
    expect(ops.some(o => o.sql.includes('CREATE TYPE'))).toBe(true)
    expect(ops.some(o => o.sql.includes('DROP TYPE'))).toBe(true)
    expect(ops.some(o => o.sql.includes('RENAME TO'))).toBe(true)
  })

  it('returns empty when enum matches', () => {
    const ops = diffEnums(
      new Map([['user_status', ['active', 'inactive']]]),
      new Map([['user_status', []]]),
      [{ name: 'user_status', values: ['active', 'inactive'] }],
    )

    expect(ops).toHaveLength(0)
  })
})
