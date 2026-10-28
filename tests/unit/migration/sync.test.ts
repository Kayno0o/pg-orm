import type { SyncContext } from '../../../src/migration/sync'
import type { QueryFn } from '../../../src/migration/types'
import { describe, expect, it } from 'bun:test'
import { DestructiveOpError } from '../../../src/errors/index'
import { defineTable } from '../../../src/index'
import { syncSchema } from '../../../src/migration/sync'

// Empty introspection: no live tables/enums/fks/indexes.
const EMPTY_ROWS: Record<string, unknown>[] = []

// `live` answers every query, the plan's outside a transaction as the applying transactions'.
function makeCtx(tables: SyncContext['tables'] = new Map(), live: (sql: string) => Record<string, unknown>[] = () => EMPTY_ROWS) {
  const txQueries: { sql: string, params: unknown[] }[] = []
  const outerQueries: { sql: string, params: unknown[] }[] = []
  const transactions: string[][] = []

  const ctx: SyncContext = {
    schema: 'public',
    tables,
    query: async (sql, params) => {
      outerQueries.push({ sql, params })

      return live(sql)
    },
    transact: async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
      const run: string[] = []

      transactions.push(run)

      return fn(async (sql, params) => {
        txQueries.push({ sql, params })
        run.push(sql)

        return live(sql)
      })
    },
  }

  return { ctx, txQueries, outerQueries, transactions }
}

// A live table no definition declares, which the plan drops.
function orphan(sql: string): Record<string, unknown>[] {
  if (!sql.includes('information_schema.columns'))
    return EMPTY_ROWS

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

const usersTable = defineTable('users', t => ({ id: t.serial().primaryKey(), name: t.text().notNull() }))

describe('syncSchema', () => {
  it('returns empty and opens no transaction when live schema matches registry', async () => {
    const { ctx, transactions } = makeCtx()

    expect(await syncSchema(ctx)).toEqual({ sql: '', ops: [] })
    expect(transactions).toHaveLength(0)
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

  it('throws DestructiveOpError for drop_table without allowDestructive, before any transaction', async () => {
    const { ctx, transactions } = makeCtx(new Map(), orphan)

    await expect(syncSchema(ctx)).rejects.toBeInstanceOf(DestructiveOpError)
    expect(transactions).toHaveLength(0)
  })

  it('allowDestructive suppresses the DestructiveOpError', async () => {
    const { ctx } = makeCtx(new Map(), orphan)
    const result = await syncSchema(ctx, { allowDestructive: true })

    expect(result.ops.some(o => o.type === 'drop_table')).toBe(true)
  })

  it('refuses to apply an op the plan did not show, when the schema changed before the lock', async () => {
    let planned = false
    const { ctx, txQueries } = makeCtx(new Map([[usersTable.name, usersTable]]) as unknown as SyncContext['tables'], (sql) => {
      if (sql.includes('information_schema.columns') && !planned) {
        planned = true

        return EMPTY_ROWS
      }

      return orphan(sql)
    })

    await expect(syncSchema(ctx, { allowDestructive: true })).rejects.toThrow('The schema changed while sync waited for its lock: Drop table "orphan"')
    expect(txQueries.some(q => q.sql.includes('CREATE TABLE'))).toBe(false)
  })
})

describe('syncSchema introspection', () => {
  const tickets = defineTable('tickets', t => ({ id: t.serial().primaryKey(), state: t.enum('ticket_state', ['open', 'closed'] as const) }))
  const registry = new Map([[tickets.name, tickets]]) as unknown as SyncContext['tables']
  const columnReads = (queries: { sql: string }[]) => queries.filter(q => q.sql.includes('FROM information_schema.columns')).length

  it('plans outside a transaction, then reads the schema once more under the lock, the first transaction reading the enums alone', async () => {
    const { ctx, txQueries, outerQueries } = makeCtx(registry)

    await syncSchema(ctx, { allowDestructive: true })

    expect(columnReads(outerQueries)).toBe(1)
    expect(columnReads(txQueries)).toBe(1)
    expect(txQueries.filter(q => q.sql.includes('FROM pg_type')).length).toBe(2)
  })

  it('adds a live enum\'s missing value in a transaction of its own, before the one applying the rest, and records it', async () => {
    const { ctx, transactions } = makeCtx(registry, sql => sql.includes('FROM pg_type') ? [{ enum_name: 'ticket_state', enum_value: 'open', enumsortorder: 1 }] : EMPTY_ROWS)
    const result = await syncSchema(ctx, { allowDestructive: true })

    expect(transactions[0]!.some(sql => sql.includes('ADD VALUE'))).toBe(true)
    expect(columnReads(transactions[0]!.map(sql => ({ sql })))).toBe(0)
    expect(transactions[1]!.some(sql => sql.includes('ADD VALUE'))).toBe(false)
    expect(result.ops.map(o => o.type)).toContain('alter_enum_add')
    expect(transactions[1]!.find(sql => sql.includes('_pgorm_migrations') && sql.includes('INSERT'))).toBeDefined()
  })

  it('adds no enum value when the destructive gate refuses the sync', async () => {
    const { ctx, transactions } = makeCtx(registry, sql => sql.includes('FROM pg_type') ? [{ enum_name: 'ticket_state', enum_value: 'open', enumsortorder: 1 }] : orphan(sql))

    await expect(syncSchema(ctx)).rejects.toBeInstanceOf(DestructiveOpError)
    expect(transactions).toHaveLength(0)
  })
})
