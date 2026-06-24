import type { AnyTableDef } from '../../../src/types/index'
import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../src/index'
import { diffTables } from '../../../src/migration/diff/tables'

function liveTable(name: string, columns: { name: string, dataType: string, isNullable: boolean, defaultValue: string | null, isPrimaryKey: boolean, isUnique: boolean, isGenerated: boolean }[]) {
  return { name, columns }
}

function registry(...tables: AnyTableDef[]) {
  return new Map(tables.map(t => [t.name, t]))
}

describe('diffTables', () => {
  it('creates missing table', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))
    const ops = diffTables(registry(table), [])

    expect(ops).toHaveLength(1)
    expect(ops[0]!.type).toBe('create_table')
    expect(ops[0]!.table).toBe('users')
    expect(ops[0]!.sql).toContain('CREATE TABLE "users"')
  })

  it('drops table not in desired schema', () => {
    const ops = diffTables(registry(), [liveTable('old', [
      { name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, isPrimaryKey: true, isUnique: false, isGenerated: false },
    ])])

    expect(ops).toHaveLength(1)
    expect(ops[0]!.type).toBe('drop_table')
    expect(ops[0]!.table).toBe('old')
    expect(ops[0]!.destructive).toBe(true)
  })

  it('returns empty when table matches', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))
    const ops = diffTables(registry(table), [liveTable('users', [
      { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
    ])])

    expect(ops).toHaveLength(0)
  })

  it('handles simultaneous create and drop', () => {
    const users = defineTable('users', t => ({ id: t.serial().primaryKey() }))
    const ops = diffTables(registry(users), [liveTable('old', [
      { name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, isPrimaryKey: true, isUnique: false, isGenerated: false },
    ])])

    expect(ops.some(o => o.type === 'create_table' && o.table === 'users')).toBe(true)
    expect(ops.some(o => o.type === 'drop_table' && o.table === 'old')).toBe(true)
  })

  it('delegates column diffs for existing tables', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const ops = diffTables(registry(table), [liveTable('users', [
      { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
    ])])

    expect(ops).toHaveLength(1)
    expect(ops[0]!.type).toBe('add_column')
    expect(ops[0]!.column).toBe('name')
  })
})
