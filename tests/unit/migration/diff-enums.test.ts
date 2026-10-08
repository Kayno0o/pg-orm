import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../src/index'
import { collectEnumRequirements, diffEnums } from '../../../src/migration/diff/enums'

function registry(...tables: any[]) {
  return new Map(tables.map(t => [t.name, t]))
}

describe('collectEnumRequirements', () => {
  it('collects enum names and values from desired tables, an enum array included', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('user_status', ['active', 'inactive'] as const).notNull(),
      roles: t.array(t.enum('user_role', ['admin', 'member'] as const)),
    }))
    const neededEnums = collectEnumRequirements(registry(table))

    expect(neededEnums.get('user_status')).toEqual(['active', 'inactive'])
    expect(neededEnums.get('user_role')).toEqual(['admin', 'member'])
  })

  it('returns an empty map when no enums are used', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))

    expect(collectEnumRequirements(registry(table)).size).toBe(0)
  })
})

describe('diffEnums', () => {
  it('creates missing enum', () => {
    const ops = diffEnums(
      new Map([['user_status', ['active', 'inactive']]]),
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
      [{ name: 'user_status', values: ['active', 'inactive'] }],
      [{ name: 'users', columns: [{ name: 'status', dataType: 'user_status', isNullable: false, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false }] }],
    )

    expect(ops.length).toBeGreaterThanOrEqual(3)
    expect(ops.every(o => o.type === 'alter_enum_remove')).toBe(true)
    expect(ops.every(o => o.destructive)).toBe(true)
    expect(ops.some(o => o.sql.includes('CREATE TYPE'))).toBe(true)
    expect(ops.some(o => o.sql.includes('DROP TYPE'))).toBe(true)
    expect(ops.some(o => o.sql.includes('RENAME TO'))).toBe(true)
    expect(ops.some(o => o.sql.includes('ALTER TABLE "users" ALTER COLUMN "status"'))).toBe(true)
  })

  it('returns empty when enum matches', () => {
    const ops = diffEnums(
      new Map([['user_status', ['active', 'inactive']]]),
      [{ name: 'user_status', values: ['active', 'inactive'] }],
    )

    expect(ops).toHaveLength(0)
  })
})
