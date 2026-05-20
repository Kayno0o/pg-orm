import type { Executable } from '../sql/executor'
import { MIGRATION_TABLE } from './types'

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

export interface MigrationHistoryEntry {
  id: number
  name: string
  sqlHash: string
  upSql: string
  downSql: string
  appliedAt: Date
  direction: 'up' | 'down'
}

/** Get the migration history from the history table. */
export async function getMigrationHistory(executor: Executable): Promise<MigrationHistoryEntry[]> {
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
