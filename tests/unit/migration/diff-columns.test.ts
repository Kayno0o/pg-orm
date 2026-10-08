import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../src/index'
import { diffColumn, diffComment, diffTableColumns } from '../../../src/migration/diff/columns'

function liveCol(name: string, overrides: Partial<{
  dataType: string
  isNullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  isUnique: boolean
  isGenerated: boolean
}> = {}) {
  return {
    name,
    dataType: overrides.dataType ?? 'text',
    isNullable: overrides.isNullable ?? true,
    defaultValue: overrides.defaultValue ?? null,
    isPrimaryKey: overrides.isPrimaryKey ?? false,
    isUnique: overrides.isUnique ?? false,
    isGenerated: overrides.isGenerated ?? false,
  }
}

describe('diffTableColumns', () => {
  it('adds missing column', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const ops = diffTableColumns('users', table, {
      name: 'users',
      columns: [liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false, defaultValue: 'nextval()' })],
    })

    expect(ops).toHaveLength(1)
    expect(ops[0]!.type).toBe('add_column')
    expect(ops[0]!.column).toBe('name')
  })

  it('drops column not in desired schema', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))
    const ops = diffTableColumns('users', table, {
      name: 'users',
      columns: [
        liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false, defaultValue: 'nextval()' }),
        liveCol('old', {}),
      ],
    })

    expect(ops).toHaveLength(1)
    expect(ops[0]!.type).toBe('drop_column')
    expect(ops[0]!.column).toBe('old')
    expect(ops[0]!.destructive).toBe(true)
  })

  it('renames column via renamedFrom', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      fullName: t.text().notNull().renamedFrom('name'),
    }))
    const ops = diffTableColumns('users', table, {
      name: 'users',
      columns: [
        liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false, defaultValue: 'nextval()' }),
        liveCol('name', { isNullable: false }),
      ],
    })

    expect(ops.some(o => o.type === 'rename_column')).toBe(true)
    expect(ops.every(o => o.type !== 'drop_column')).toBe(true)
    expect(ops.every(o => o.type !== 'add_column')).toBe(true)
  })
})

describe('diffColumn', () => {
  it('emits alter_column on type change', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      age: t.text().notNull(),
    }))
    const colDef = table.columns.age
    const ops = diffColumn('users', 'age', colDef, liveCol('age', { dataType: 'int4', isNullable: false }))

    expect(ops.some(o => o.type === 'alter_column' && o.sql.includes('TYPE text'))).toBe(true)
  })

  it('adds UNIQUE constraint', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      email: t.text().notNull().unique(),
    }))
    const ops = diffColumn('users', 'email', table.columns.email, liveCol('email', { isNullable: false }))

    expect(ops.some(o => o.type === 'add_constraint')).toBe(true)
  })

  it('drops UNIQUE constraint', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      email: t.text().notNull(),
    }))
    const ops = diffColumn('users', 'email', table.columns.email, liveCol('email', { isNullable: false, isUnique: true }))

    expect(ops.some(o => o.type === 'drop_constraint')).toBe(true)
  })

  it('sets NOT NULL', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const ops = diffColumn('users', 'name', table.columns.name, liveCol('name', { isNullable: true }))

    expect(ops.some(o => o.sql.includes('SET NOT NULL'))).toBe(true)
  })

  it('sets NOT NULL on a column that left nullable() out, as its type is never null', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text(),
    }))
    const ops = diffColumn('users', 'name', table.columns.name, liveCol('name', { isNullable: true }))

    expect(ops.map(o => o.sql)).toEqual(['ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL'])
  })

  it('drops NOT NULL', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().nullable(),
    }))
    const ops = diffColumn('users', 'name', table.columns.name, liveCol('name', { isNullable: false }))

    expect(ops.some(o => o.sql.includes('DROP NOT NULL'))).toBe(true)
  })

  it('sets default', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      status: t.text().notNull().default('active'),
    }))
    const ops = diffColumn('users', 'status', table.columns.status, liveCol('status', { isNullable: false }))

    expect(ops.some(o => o.sql.includes('SET DEFAULT'))).toBe(true)
  })

  it('drops default', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      status: t.text().notNull(),
    }))
    const ops = diffColumn('users', 'status', table.columns.status, liveCol('status', { isNullable: false, defaultValue: '\'active\'' }))

    expect(ops.some(o => o.sql.includes('DROP DEFAULT'))).toBe(true)
  })

  it('keeps a non-primary-key serial\'s sequence default', () => {
    const table = defineTable('users', t => ({
      id: t.uuid().primaryKey(),
      seq: t.serial(),
      big: t.bigserial(),
    }))

    expect(diffColumn('users', 'seq', table.columns.seq, liveCol('seq', { dataType: 'integer', isNullable: false, defaultValue: 'nextval(\'users_seq_seq\'::regclass)' }))).toEqual([])
    expect(diffColumn('users', 'big', table.columns.big, liveCol('big', { dataType: 'bigint', isNullable: false, defaultValue: 'nextval(\'users_big_seq\'::regclass)' }))).toEqual([])
  })

  it('finds nothing to change on a column read back as Postgres prints it', () => {
    const since = new Date('2024-01-01T10:00:00.000Z')
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      embedding: t.vector(3),
      code: t.char(5),
      labels: t.array(t.varchar(10)).default([]),
      amount: t.numeric(10, 0),
      flags: t.bit(8),
      mask: t.varbit(8),
      since: t.timestamptz().default(since),
      tags: t.array(t.text()).default([]),
      meta: t.jsonb().default({ bb: 1, a: 2 }),
    }))
    const live: Record<string, [string, string | null]> = {
      embedding: ['vector(3)', null],
      code: ['character(5)', null],
      labels: ['character varying(10)[]', '(ARRAY[]::character varying[])::character varying(10)[]'],
      amount: ['numeric(10,0)', null],
      flags: ['bit(8)', null],
      mask: ['bit varying(8)', null],
      since: ['timestamp with time zone', '\'2024-01-01 10:00:00+00\'::timestamp with time zone'],
      tags: ['text[]', '\'{}\'::text[]'],
      meta: ['jsonb', '\'{"a": 2, "bb": 1}\'::jsonb'],
    }

    for (const [name, [dataType, defaultValue]] of Object.entries(live)) {
      const colDef = table.columns[name as keyof typeof table.columns]

      expect(diffColumn('items', name, colDef, liveCol(name, { dataType, defaultValue, isNullable: false }))).toEqual([])
    }
  })
})

describe('diffComment', () => {
  it('treats an empty comment as none, as Postgres stores it', () => {
    expect(diffComment('t', 'c', '', null)).toEqual([])
    expect(diffComment('t', 'c', 'x', null)).toHaveLength(1)
  })
})
