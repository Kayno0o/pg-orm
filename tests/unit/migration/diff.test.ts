import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../src/index'
import { diffSchema } from '../../../src/migration/index'

function liveTables(tables: { name: string, columns: { name: string, dataType: string, isNullable: boolean, defaultValue: string | null, isPrimaryKey: boolean, isUnique: boolean, isGenerated: boolean }[] }[]) {
  return { tables, enums: [] }
}

function registry(...tables: any[]) {
  return new Map(tables.map(t => [t.name, t]))
}

describe('diffSchema', () => {
  it('detects new table', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const ops = diffSchema(liveTables([]), registry(table))

    expect(ops).toHaveLength(1)
    expect(ops[0]!.type).toBe('create_table')
    expect(ops[0]!.table).toBe('users')
    expect(ops[0]!.destructive).toBe(false)
    expect(ops[0]!.sql).toContain('CREATE TABLE')
  })

  it('detects dropped table', () => {
    const ops = diffSchema(
      liveTables([{
        name: 'old_table',
        columns: [{ name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, isPrimaryKey: true, isUnique: false, isGenerated: false }],
      }]),
      registry(),
    )

    expect(ops).toHaveLength(1)
    expect(ops[0]!.type).toBe('drop_table')
    expect(ops[0]!.destructive).toBe(true)
  })

  it('detects added column', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
      email: t.text().notNull(),
    }))
    const ops = diffSchema(
      liveTables([{
        name: 'users',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
          { name: 'name', dataType: 'text', isNullable: false, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
        ],
      }]),
      registry(table),
    )

    const addCol = ops.find(o => o.type === 'add_column')

    expect(addCol).toBeDefined()
    expect(addCol!.column).toBe('email')
    expect(addCol!.destructive).toBe(false)
  })

  it('detects dropped column', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))
    const ops = diffSchema(
      liveTables([{
        name: 'users',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
          { name: 'old_col', dataType: 'text', isNullable: true, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
        ],
      }]),
      registry(table),
    )

    const dropCol = ops.find(o => o.type === 'drop_column')

    expect(dropCol).toBeDefined()
    expect(dropCol!.column).toBe('old_col')
    expect(dropCol!.destructive).toBe(true)
  })

  it('detects type change (alter_column)', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      age: t.text().notNull(), // Changed from int4 to text
    }))
    const ops = diffSchema(
      liveTables([{
        name: 'users',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
          { name: 'age', dataType: 'int4', isNullable: false, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
        ],
      }]),
      registry(table),
    )

    const alter = ops.find(o => o.type === 'alter_column' && o.column === 'age')

    expect(alter).toBeDefined()
    expect(alter!.destructive).toBe(true)
  })

  it('detects nullability change (set NOT NULL)', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const ops = diffSchema(
      liveTables([{
        name: 'users',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
          { name: 'name', dataType: 'text', isNullable: true, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
        ],
      }]),
      registry(table),
    )

    const alter = ops.find(o => o.sql.includes('SET NOT NULL'))

    expect(alter).toBeDefined()
  })

  it('detects nullability change (drop NOT NULL)', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().nullable(),
    }))
    const ops = diffSchema(
      liveTables([{
        name: 'users',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
          { name: 'name', dataType: 'text', isNullable: false, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
        ],
      }]),
      registry(table),
    )

    const alter = ops.find(o => o.sql.includes('DROP NOT NULL'))

    expect(alter).toBeDefined()
  })

  it('no ops when schema matches', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const ops = diffSchema(
      liveTables([{
        name: 'users',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
          { name: 'name', dataType: 'text', isNullable: false, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
        ],
      }]),
      registry(table),
    )

    expect(ops).toHaveLength(0)
  })

  it('normalizes serial to integer', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))
    const ops = diffSchema(
      liveTables([{
        name: 'users',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
        ],
      }]),
      registry(table),
    )

    expect(ops).toHaveLength(0)
  })

  it('normalizes int4 to integer', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      count: t.int4().notNull(),
    }))
    const ops = diffSchema(
      liveTables([{
        name: 'users',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
          { name: 'count', dataType: 'int4', isNullable: false, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
        ],
      }]),
      registry(table),
    )

    expect(ops).toHaveLength(0)
  })

  it('normalizes bool to boolean', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      active: t.bool().notNull(),
    }))
    const ops = diffSchema(
      liveTables([{
        name: 'users',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
          { name: 'active', dataType: 'bool', isNullable: false, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
        ],
      }]),
      registry(table),
    )

    expect(ops).toHaveLength(0)
  })

  it('handles enum creation', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('user_status', ['active', 'inactive'] as const).notNull(),
    }))
    const ops = diffSchema(liveTables([]), registry(table))

    const enumOp = ops.find(o => o.type === 'create_enum')

    expect(enumOp).toBeDefined()
    expect(enumOp!.sql).toContain('CREATE TYPE')
    expect(enumOp!.sql).toContain('active')
  })

  it('handles enum add value', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('user_status', ['active', 'inactive', 'banned'] as const).notNull(),
    }))
    const ops = diffSchema(
      {
        tables: [{
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
            { name: 'status', dataType: 'user_status', isNullable: false, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
          ],
        }],
        enums: [{ name: 'user_status', values: ['active', 'inactive'] }],
      },
      registry(table),
    )

    const enumOp = ops.find(o => o.type === 'alter_enum_add')

    expect(enumOp).toBeDefined()
    expect(enumOp!.sql).toContain('ADD VALUE')
    expect(enumOp!.sql).toContain('banned')
  })

  it('handles enum value removal', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('user_status', ['active'] as const).notNull(),
    }))
    const ops = diffSchema(
      {
        tables: [{
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false, defaultValue: 'nextval()', isPrimaryKey: true, isUnique: false, isGenerated: false },
            { name: 'status', dataType: 'user_status', isNullable: false, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
          ],
        }],
        enums: [{ name: 'user_status', values: ['active', 'inactive'] }],
      },
      registry(table),
    )

    const enumOps = ops.filter(o => o.type === 'alter_enum_remove')

    expect(enumOps.length).toBeGreaterThan(0)
    expect(enumOps.some(o => o.destructive)).toBe(true)
  })

  it('create table generates DDL with constraints', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull().unique(),
      value: t.int4().check('value > 0'),
    }))
    const ops = diffSchema(liveTables([]), registry(table))
    const createOp = ops.find(o => o.type === 'create_table')

    expect(createOp!.sql).toContain('PRIMARY KEY')
    expect(createOp!.sql).toContain('UNIQUE')
    expect(createOp!.sql).toContain('CHECK')
  })
})
