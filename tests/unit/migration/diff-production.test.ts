import { describe, expect, it } from 'bun:test'
import { AfterHookError, defineTable } from '../../../src/index'
import { diffSchema } from '../../../src/migration/index'

// --- Helpers ---

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

function live(
  tables: { name: string, columns: ReturnType<typeof liveCol>[] }[],
  enums: { name: string, values: string[] }[] = [],
  foreignKeys: any[] = [],
  indexes: any[] = [],
) {
  return { tables, enums, foreignKeys, indexes }
}

function registry(...tables: any[]) {
  return new Map(tables.map(t => [t.name, t]))
}

// --- Index Diffing ---

describe('diffSchema — index diffing', () => {
  it('creates index for column with .index()', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      email: t.text().notNull().index(),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('email', { dataType: 'text', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    const indexOp = ops.find(o => o.type === 'create_index')

    expect(indexOp).toBeDefined()
    expect(indexOp!.sql).toContain('CREATE INDEX')
    expect(indexOp!.sql).toContain('"email"')
    expect(indexOp!.sql).toContain('USING btree')
    expect(indexOp!.destructive).toBe(false)
  })

  it('creates index with custom method', () => {
    const table = defineTable('docs', t => ({
      id: t.serial().primaryKey(),
      data: t.jsonb().index({ method: 'gin' }),
    }))
    const ops = diffSchema(
      live([{
        name: 'docs',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('data', { dataType: 'jsonb', isNullable: true }),
        ],
      }]),
      registry(table),
    )

    const indexOp = ops.find(o => o.type === 'create_index')

    expect(indexOp).toBeDefined()
    expect(indexOp!.sql).toContain('USING gin')
  })

  it('creates composite index via withIndexes()', () => {
    const table = defineTable('events', t => ({
      id: t.serial().primaryKey(),
      userId: t.int4().notNull(),
      createdAt: t.timestamptz().notNull(),
    })).withIndexes([
      { columns: ['userId', 'createdAt'], method: 'btree' },
    ])
    const ops = diffSchema(
      live([{
        name: 'events',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('userId', { dataType: 'int4', isNullable: false }),
          liveCol('createdAt', { dataType: 'timestamptz', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    const indexOp = ops.find(o => o.type === 'create_index')

    expect(indexOp).toBeDefined()
    expect(indexOp!.sql).toContain('"userId"')
    expect(indexOp!.sql).toContain('"createdAt"')
  })

  it('drops index that no longer exists in schema', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      email: t.text().notNull(),
    }))
    const ops = diffSchema(
      live(
        [{
          name: 'users',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
            liveCol('email', { dataType: 'text', isNullable: false }),
          ],
        }],
        [],
        [],
        [{
          name: 'users_email_idx',
          tableName: 'users',
          columns: ['email'],
          isUnique: false,
          method: 'btree',
          definition: 'CREATE INDEX users_email_idx ON users USING btree (email)',
        }],
      ),
      registry(table),
    )

    const dropOp = ops.find(o => o.type === 'drop_index')

    expect(dropOp).toBeDefined()
    expect(dropOp!.sql).toContain('DROP INDEX')
    expect(dropOp!.destructive).toBe(true)
  })

  it('skips existing index that matches', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      email: t.text().notNull().index(),
    }))
    const ops = diffSchema(
      live(
        [{
          name: 'users',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
            liveCol('email', { dataType: 'text', isNullable: false }),
          ],
        }],
        [],
        [],
        [{
          name: 'users_email_idx',
          tableName: 'users',
          columns: ['email'],
          isUnique: false,
          method: 'btree',
          definition: 'CREATE INDEX users_email_idx ON users USING btree (email)',
        }],
      ),
      registry(table),
    )

    expect(ops.filter(o => o.type === 'create_index' || o.type === 'drop_index')).toHaveLength(0)
  })

  it('creates partial index with WHERE clause', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      email: t.text().notNull().index({ where: 'email IS NOT NULL' }),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('email', { dataType: 'text', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    const indexOp = ops.find(o => o.type === 'create_index')

    expect(indexOp).toBeDefined()
    expect(indexOp!.sql).toContain('WHERE email IS NOT NULL')
  })
})

// --- Column Rename Detection ---

describe('diffSchema — column rename detection', () => {
  it('detects column rename via renamedFrom()', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      fullName: t.text().notNull().renamedFrom('name'),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('name', { dataType: 'text', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    const renameOp = ops.find(o => o.type === 'rename_column')

    expect(renameOp).toBeDefined()
    expect(renameOp!.sql).toContain('RENAME COLUMN "name" TO "fullName"')
    expect(renameOp!.destructive).toBe(false)

    // Should NOT have drop+add
    expect(ops.filter(o => o.type === 'drop_column')).toHaveLength(0)
    expect(ops.filter(o => o.type === 'add_column')).toHaveLength(0)
  })

  it('falls back to drop+add without renamedFrom()', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      fullName: t.text().notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('name', { dataType: 'text', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    expect(ops.some(o => o.type === 'drop_column' && o.column === 'name')).toBe(true)
    expect(ops.some(o => o.type === 'add_column' && o.column === 'fullName')).toBe(true)
    expect(ops.filter(o => o.type === 'rename_column')).toHaveLength(0)
  })

  it('detects type change after rename', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      email: t.varchar(255).notNull().renamedFrom('mail'),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('mail', { dataType: 'text', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    expect(ops.some(o => o.type === 'rename_column')).toBe(true)
    expect(ops.some(o => o.type === 'alter_column' && o.column === 'email')).toBe(true)
  })
})

// --- UNIQUE Constraint Diffing ---

describe('diffSchema — UNIQUE constraint diffing', () => {
  it('adds UNIQUE constraint to existing column', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      email: t.text().notNull().unique(),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('email', { dataType: 'text', isNullable: false, isUnique: false }),
        ],
      }]),
      registry(table),
    )

    const uqOp = ops.find(o => o.type === 'add_constraint')

    expect(uqOp).toBeDefined()
    expect(uqOp!.sql).toContain('UNIQUE')
    expect(uqOp!.destructive).toBe(false)
  })

  it('drops UNIQUE constraint when removed from schema', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      email: t.text().notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('email', { dataType: 'text', isNullable: false, isUnique: true }),
        ],
      }]),
      registry(table),
    )

    const dropOp = ops.find(o => o.type === 'drop_constraint')

    expect(dropOp).toBeDefined()
    expect(dropOp!.sql).toContain('DROP CONSTRAINT')
    expect(dropOp!.destructive).toBe(true)
  })

  it('does not diff UNIQUE on PK columns', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false, isUnique: false }),
        ],
      }]),
      registry(table),
    )

    expect(ops.filter(o => o.type === 'add_constraint' || o.type === 'drop_constraint')).toHaveLength(0)
  })

  it('no-op when UNIQUE already matches', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      email: t.text().notNull().unique(),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('email', { dataType: 'text', isNullable: false, isUnique: true }),
        ],
      }]),
      registry(table),
    )

    expect(ops.filter(o => o.type === 'add_constraint' || o.type === 'drop_constraint')).toHaveLength(0)
  })
})

// --- AfterHookError ---

describe('AfterHookError', () => {
  it('has committed flag set to true', () => {
    const err = new AfterHookError('users', 'afterInsert', new Error('boom'))

    expect(err.committed).toBe(true)
    expect(err.table).toBe('users')
    expect(err.hook).toBe('afterInsert')
    expect(err.name).toBe('AfterHookError')
    expect(err.message).toContain('afterInsert')
    expect(err.message).toContain('boom')
    expect(err.message).toContain('NOT rolled back')
  })

  it('handles non-Error cause', () => {
    const err = new AfterHookError('posts', 'afterDelete', 'string error')

    expect(err.committed).toBe(true)
    expect(err.message).toContain('string error')
  })
})

// --- Retry Jitter ---

describe('retry jitter', () => {
  it('delay calculation produces variance', () => {
    const delays = new Set<number>()
    const baseDelay = 100
    const maxDelay = 5000

    for (let i = 0; i < 20; i++) {
      const base = Math.min(baseDelay * 2 ** 0, maxDelay)
      const delay = base * (0.5 + Math.random() * 0.5)

      delays.add(Math.round(delay))
    }

    // With jitter, we should get multiple distinct delay values
    expect(delays.size).toBeGreaterThan(1)
  })

  it('jitter stays within bounds', () => {
    const baseDelay = 100
    const maxDelay = 5000

    for (let attempt = 0; attempt < 10; attempt++) {
      const base = Math.min(baseDelay * 2 ** attempt, maxDelay)
      const delay = base * (0.5 + Math.random() * 0.5)

      expect(delay).toBeGreaterThanOrEqual(base * 0.5)
      expect(delay).toBeLessThanOrEqual(base)
    }
  })
})
