import type { MigrationHistoryEntry } from '../../../src/migration/history'
import type { RollbackContext } from '../../../src/migration/rollback'
import type { QueryFn } from '../../../src/migration/types'
import { beforeEach, describe, expect, it } from 'bun:test'
import { MigrationError, ValidationError } from '../../../src/errors/index'
import { rollbackMigrations } from '../../../src/migration/rollback'

interface ExecutedQuery { sql: string, params: unknown[] }

function makeContext(history: MigrationHistoryEntry[]) {
  const executed: ExecutedQuery[] = []
  const ctxQueries: ExecutedQuery[] = []
  const inserted: { name: string, direction: string, downSql: string, sqlHash: string }[] = []

  const serveHistory = (sql: string) => (/^\s*SELECT[\s\S]+_pgorm_migrations/).test(sql)
    ? history.map(m => ({
      id: m.id,
      name: m.name,
      sql_hash: m.sqlHash,
      up_sql: m.upSql,
      down_sql: m.downSql,
      applied_at: m.appliedAt,
      direction: m.direction,
    }))
    : undefined

  const ctx: RollbackContext = {
    query: async (sql, params) => {
      ctxQueries.push({ sql, params })

      return serveHistory(sql) ?? []
    },
    transact: async <T>(fn: (query: QueryFn) => Promise<T>): Promise<T> => {
      return fn(async (sql, params) => {
        executed.push({ sql, params })

        const rows = serveHistory(sql)

        if (rows)
          return rows

        const m = sql.match(/INSERT INTO[\s\S]+VALUES \(\$1, \$2, \$3, \$4, \$5\)/)

        if (m) {
          inserted.push({
            name: String(params[0]),
            sqlHash: String(params[1]),
            downSql: String(params[3]),
            direction: String(params[4]),
          })
        }

        return []
      })
    },
  }

  return { ctx, executed, ctxQueries, inserted }
}

function entry(opts: Partial<MigrationHistoryEntry> & { name: string }): MigrationHistoryEntry {
  return {
    id: opts.id ?? 1,
    name: opts.name,
    sqlHash: opts.sqlHash ?? 'h',
    upSql: opts.upSql ?? 'CREATE TABLE foo()',
    downSql: opts.downSql ?? 'DROP TABLE foo',
    appliedAt: opts.appliedAt ?? new Date(0),
    direction: opts.direction ?? 'up',
  }
}

describe('rollbackMigrations', () => {
  let lastResult: { rolledBack: string[], sql: string }

  beforeEach(() => {
    lastResult = { rolledBack: [], sql: '' }
  })

  it('rejects a count that is not a positive integer rather than rolling back everything', async () => {
    for (const count of [0, -1, Number.NaN, 1.5]) {
      const { ctx, executed } = makeContext([entry({ id: 1, name: 'm1' })])

      await expect(rollbackMigrations(ctx, count)).rejects.toThrow(ValidationError)
      expect(executed).toEqual([])
    }
  })

  it('returns empty when no migrations exist', async () => {
    const { ctx } = makeContext([])

    lastResult = await rollbackMigrations(ctx)
    expect(lastResult.rolledBack).toEqual([])
    expect(lastResult.sql).toBe('')
  })

  it('returns empty when all migrations are already rolled back', async () => {
    const { ctx, inserted } = makeContext([
      entry({ id: 1, name: 'm1', direction: 'up' }),
      entry({ id: 2, name: 'm1', direction: 'down' }),
    ])

    lastResult = await rollbackMigrations(ctx, 1)
    expect(lastResult.rolledBack).toEqual([])
    expect(inserted).toEqual([])
  })

  it('rolls back a single up migration', async () => {
    const { ctx, executed, inserted } = makeContext([
      entry({ id: 1, name: 'm1', downSql: 'DROP TABLE m1' }),
    ])

    lastResult = await rollbackMigrations(ctx, 1)
    expect(lastResult.rolledBack).toEqual(['m1'])
    expect(lastResult.sql).toBe('DROP TABLE m1')
    expect(executed.find(q => q.sql === 'DROP TABLE m1')).toBeDefined()
    expect(inserted[0]).toMatchObject({ name: 'm1', direction: 'down', downSql: 'DROP TABLE m1' })
    expect(inserted[0]!.sqlHash).toMatch(/^[0-9a-z]+$/) // djb2 base36
  })

  it('rolls back N migrations in reverse application order', async () => {
    const { ctx, executed } = makeContext([
      entry({ id: 1, name: 'm1', downSql: 'DROP TABLE m1' }),
      entry({ id: 2, name: 'm2', downSql: 'DROP TABLE m2' }),
      entry({ id: 3, name: 'm3', downSql: 'DROP TABLE m3' }),
    ])

    lastResult = await rollbackMigrations(ctx, 2)
    expect(lastResult.rolledBack).toEqual(['m3', 'm2'])
    const downSqls = executed.filter(q => q.sql.startsWith('DROP TABLE m')).map(q => q.sql)

    expect(downSqls).toEqual(['DROP TABLE m3', 'DROP TABLE m2'])
    expect(lastResult.sql).toBe('DROP TABLE m3\n\nDROP TABLE m2')
  })

  it('skips already-rolled-back migrations when selecting the slice', async () => {
    const { ctx } = makeContext([
      entry({ id: 1, name: 'm1' }),
      entry({ id: 2, name: 'm2' }),
      entry({ id: 3, name: 'm2', direction: 'down' }), // m2 already rolled back
    ])

    lastResult = await rollbackMigrations(ctx, 1)
    expect(lastResult.rolledBack).toEqual(['m1'])
  })

  it('throws MigrationError when down SQL is missing', async () => {
    const { ctx } = makeContext([
      entry({ id: 1, name: 'm1', downSql: '' }),
    ])

    await expect(rollbackMigrations(ctx, 1)).rejects.toBeInstanceOf(MigrationError)
  })

  it('throws MigrationError when down SQL is only whitespace', async () => {
    const { ctx } = makeContext([
      entry({ id: 1, name: 'm1', downSql: '   \n\t  ' }),
    ])

    await expect(rollbackMigrations(ctx, 1)).rejects.toBeInstanceOf(MigrationError)
  })

  it('refuses an irreversible migration before running or recording anything', async () => {
    const { ctx, executed, inserted } = makeContext([
      entry({ id: 1, name: 'm1', downSql: 'DROP TABLE m1' }),
      entry({ id: 2, name: 'm2', downSql: 'ALTER TABLE "t" DROP COLUMN IF EXISTS "a";\n-- Cannot reverse: Drop column "b" from "t"' }),
    ])

    await expect(rollbackMigrations(ctx, 2)).rejects.toThrow('Drop column "b" from "t" has no reverse')
    expect(executed.filter(q => q.sql.startsWith('DROP') || q.sql.startsWith('ALTER'))).toEqual([])
    expect(inserted).toEqual([])
  })

  it('cancels a rollback against the latest application of its name, so a name applied twice stays live once', async () => {
    const { ctx } = makeContext([
      entry({ id: 1, name: 'same', downSql: 'DROP TABLE a' }),
      entry({ id: 2, name: 'same', downSql: 'DROP TABLE b' }),
      entry({ id: 3, name: 'same', downSql: 'DROP TABLE b', direction: 'down' }),
    ])

    lastResult = await rollbackMigrations(ctx, 1)
    expect(lastResult.sql).toBe('DROP TABLE a')
  })

  it('caps count at total pending rollbacks (count > history)', async () => {
    const { ctx } = makeContext([
      entry({ id: 1, name: 'm1' }),
    ])

    lastResult = await rollbackMigrations(ctx, 5)
    expect(lastResult.rolledBack).toEqual(['m1'])
  })

  it('uses count=1 by default', async () => {
    const { ctx } = makeContext([
      entry({ id: 1, name: 'm1' }),
      entry({ id: 2, name: 'm2' }),
    ])

    lastResult = await rollbackMigrations(ctx)
    expect(lastResult.rolledBack).toEqual(['m2'])
  })
})
