import type { SyncContext } from '../../../src/migration/sync'
import type { QueryFn } from '../../../src/migration/types'
import { describe, expect, it } from 'bun:test'
import { DestructiveOpError } from '../../../src/errors/index'
import { defineTable } from '../../../src/index'
import { syncSchema } from '../../../src/migration/sync'

// Empty introspection: no live tables/enums/fks/indexes.
const EMPTY_ROWS: Record<string, unknown>[] = []

function makeCtx(tables: SyncContext['tables'] = new Map()) {
  const txQueries: { sql: string, params: unknown[] }[] = []
  const outerQueries: { sql: string, params: unknown[] }[] = []

  const ctx: SyncContext = {
    schema: 'public',
    tables,
    query: async (sql, params) => {
      outerQueries.push({ sql, params })

      return EMPTY_ROWS
    },
    transact: async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
      return fn(async (sql, params) => {
        txQueries.push({ sql, params })

        return EMPTY_ROWS
      })
    },
  }

  return { ctx, txQueries, outerQueries }
}

const usersTable = defineTable('users', t => ({ id: t.serial().primaryKey(), name: t.text().notNull() }))

describe('syncSchema', () => {
  it('returns empty and skips transact when live schema matches registry', async () => {
    let transactCalled = false
    const { ctx } = makeCtx()

    ctx.transact = async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
      transactCalled = true

      return fn(async () => EMPTY_ROWS)
    }

    // Empty registry + empty live schema = no ops
    const result = await syncSchema(ctx)

    expect(result).toEqual({ sql: '', ops: [] })
    // transact IS called (advisory lock), but returns empty inside
    expect(transactCalled).toBe(true)
  })

  it('executes DDL inside transact when tables are missing from live schema', async () => {
    const tables = new Map([[usersTable.name, usersTable as unknown as SyncContext['tables'] extends Map<string, infer V> ? V : never]])
    const { ctx, txQueries } = makeCtx(tables as SyncContext['tables'])
    const result = await syncSchema(ctx)

    // Should have produced CREATE TABLE sql
    expect(result.ops.some(o => o.type === 'create_table' && o.table === 'users')).toBe(true)
    expect(result.sql).toContain('CREATE TABLE')

    // DDL executed inside transaction
    const ddlQuery = txQueries.find(q => q.sql.includes('CREATE TABLE'))

    expect(ddlQuery).toBeDefined()
  })

  it('dryRun skips DDL execution but returns sql and ops', async () => {
    const tables = new Map([[usersTable.name, usersTable as unknown as SyncContext['tables'] extends Map<string, infer V> ? V : never]])
    const { ctx, txQueries } = makeCtx(tables as SyncContext['tables'])
    const result = await syncSchema(ctx, { dryRun: true })

    expect(result.ops.length).toBeGreaterThan(0)
    expect(result.sql).toContain('CREATE TABLE')

    // No DDL executed in the transaction
    const ddlQuery = txQueries.find(q => q.sql.includes('CREATE TABLE'))

    expect(ddlQuery).toBeUndefined()
  })

  it('throws DestructiveOpError for drop_table without allowDestructive', async () => {
    // Live schema has a table not in registry → drop_table op
    const { ctx } = makeCtx()

    // Override transact to simulate a live table that isn't in registry
    ctx.transact = async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
      return fn(async (sql) => {
        // Return a columns row for a table not in registry
        if (sql.includes('information_schema.columns')) {
          return [{
            table_name: 'orphan',
            column_name: 'id',
            data_type: 'integer',
            formatted_type: 'integer',
            is_nullable: 'NO',
            column_default: null,
            is_generated: 'NEVER',
            generation_expression: null,
          }]
        }

        return EMPTY_ROWS
      })
    }

    await expect(syncSchema(ctx)).rejects.toBeInstanceOf(DestructiveOpError)
  })

  it('allowDestructive suppresses the DestructiveOpError', async () => {
    const { ctx } = makeCtx()

    ctx.transact = async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
      return fn(async (sql) => {
        if (sql.includes('information_schema.columns')) {
          return [{
            table_name: 'orphan',
            column_name: 'id',
            data_type: 'integer',
            formatted_type: 'integer',
            is_nullable: 'NO',
            column_default: null,
            is_generated: 'NEVER',
            generation_expression: null,
          }]
        }

        return EMPTY_ROWS
      })
    }

    const result = await syncSchema(ctx, { allowDestructive: true })

    expect(result.ops.some(o => o.type === 'drop_table')).toBe(true)
  })
})

describe('syncSchema introspection', () => {
  const tickets = defineTable('tickets', t => ({ id: t.serial().primaryKey(), state: t.enum('ticket_state', ['open', 'closed'] as const) }))
  const registry = new Map([[tickets.name, tickets]]) as unknown as SyncContext['tables']
  const columnReads = (queries: { sql: string }[]) => queries.filter(q => q.sql.includes('FROM information_schema.columns')).length

  it('reads the schema once when no enum gains a value, the first transaction reading the enums alone', async () => {
    const { ctx, txQueries } = makeCtx(registry)

    await syncSchema(ctx, { allowDestructive: true })

    expect(columnReads(txQueries)).toBe(1)
    expect(txQueries.filter(q => q.sql.includes('FROM pg_type')).length).toBe(2)
  })

  it('adds a live enum\'s missing value in a transaction of its own, before the one applying the rest', async () => {
    const transactions: string[][] = []
    const { ctx } = makeCtx(registry)

    ctx.transact = async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
      const run: string[] = []

      transactions.push(run)

      return fn(async (sql) => {
        run.push(sql)

        return sql.includes('FROM pg_type') ? [{ enum_name: 'ticket_state', enum_value: 'open', enumsortorder: 1 }] : EMPTY_ROWS
      })
    }

    await syncSchema(ctx, { allowDestructive: true })

    expect(transactions[0]!.some(sql => sql.includes('ADD VALUE'))).toBe(true)
    expect(columnReads(transactions[0]!.map(sql => ({ sql })))).toBe(0)
    expect(transactions[1]!.some(sql => sql.includes('ADD VALUE'))).toBe(false)
  })
})
