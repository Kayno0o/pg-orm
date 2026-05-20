import type { Executable } from '../sql/executor'
import type { AnyTableDef } from '../types/index'
import type { MigrationFile, MigrationOp } from './types'
import { DestructiveOpError, MigrationError } from '../errors/index'
import { TIMESTAMP_DELIM_RE } from '../utils/regex'
import { generateReverseOp } from './ddl'
import { diffSchema } from './diff'
import { introspectLiveSchema } from './introspect'
import { MIGRATION_TABLE } from './types'

export { diffSchema } from './diff'
export { introspectLiveSchema } from './introspect'
export type { MigrationFile, MigrationOp } from './types'

/** Generate a timestamped migration file with up/down SQL from the schema diff. */
export async function generateMigration(
  executor: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
  opts: { allowDestructive?: boolean } = {},
): Promise<MigrationFile | null> {
  const live = await introspectLiveSchema(executor)
  const ops = diffSchema(live, registry)

  if (ops.length === 0)
    return null

  const destructiveOps = ops.filter(o => o.destructive)

  if (destructiveOps.length && !opts.allowDestructive) {
    throw new DestructiveOpError(
      `Migration contains ${destructiveOps.length} destructive operation(s). Use --allow-destructive to proceed.`,
      'diff',
      destructiveOps.map(o => o.description),
    )
  }

  const timestamp = new Date().toISOString().replace(TIMESTAMP_DELIM_RE, '-').slice(0, 19)
  const upSql = ops.map(o => `${o.sql};`).join('\n\n')
  const downSql = ops.reverse().map((o: MigrationOp) => generateReverseOp(o)).filter(Boolean).join('\n\n')

  return {
    name: `${timestamp}_migration`,
    up: upSql,
    down: downSql,
  }
}

/** Execute raw migration SQL against the database. Wraps errors in MigrationError. */
export async function applyMigration(executor: Executable, sql: string): Promise<void> {
  try {
    await executor.query(sql, [])
  }
  catch (err) {
    throw new MigrationError(
      `Migration apply failed: ${err instanceof Error ? err.message : String(err)}`,
      'apply',
      undefined,
      err,
    )
  }
}

/** Ensure the migration history table exists. */
export async function ensureMigrationTable(executor: Executable): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS "${MIGRATION_TABLE}" (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sql_hash TEXT NOT NULL,
      up_sql TEXT NOT NULL,
      down_sql TEXT NOT NULL DEFAULT '',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      direction TEXT NOT NULL DEFAULT 'up'
    )
  `, [])
}

/** Record a migration in the history table. */
export async function recordMigration(
  executor: Executable,
  entry: { name: string, sqlHash: string, upSql: string, downSql: string, direction?: 'up' | 'down' },
): Promise<void> {
  await executor.query(`
    INSERT INTO "${MIGRATION_TABLE}" (name, sql_hash, up_sql, down_sql, direction)
    VALUES ($1, $2, $3, $4, $5)
  `, [entry.name, entry.sqlHash, entry.upSql, entry.downSql, entry.direction ?? 'up'])
}

/** Get the migration history from the history table. */
export async function getMigrationHistory(executor: Executable): Promise<{
  id: number
  name: string
  sqlHash: string
  upSql: string
  downSql: string
  appliedAt: Date
  direction: 'up' | 'down'
}[]> {
  await ensureMigrationTable(executor)
  const rows = await executor.query(`
    SELECT id, name, sql_hash, up_sql, down_sql, applied_at, direction
    FROM "${MIGRATION_TABLE}"
    ORDER BY id ASC
  `, [])

  return rows.map(r => ({
    id: Number(r.id),
    name: r.name as string,
    sqlHash: r.sql_hash as string,
    upSql: r.up_sql as string,
    downSql: r.down_sql as string,
    appliedAt: r.applied_at as Date,
    direction: r.direction as 'up' | 'down',
  }))
}

/** Check if the live database has drifted from the desired schema. */
export async function getMigrationStatus(
  executor: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
): Promise<{
  drift: MigrationOp[]
  hasDrift: boolean
}> {
  const live = await introspectLiveSchema(executor)
  const drift = diffSchema(live, registry)

  return { drift, hasDrift: drift.length > 0 }
}
