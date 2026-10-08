import type { Dialect } from '../dialect'
import type { QueryFn } from './types'
import { dialectOf } from '../dialect'
import { TIMESTAMP_DELIM_RE } from '../utils/regex'
import { MIGRATION_TABLE } from './types'

/** A migration name that sorts in creation order and stays unique however fast migrations come: the time to the millisecond, then a random suffix. */
export function migrationName(label: string): string {
  const timestamp = new Date().toISOString().replace(TIMESTAMP_DELIM_RE, '-').slice(0, 23)

  return `${timestamp}_${crypto.randomUUID().slice(0, 8)}_${label}`
}

/** Ensure the migration history table exists. */
export async function ensureMigrationTable(executor: { query: QueryFn, dialect?: Dialect }, dialect = dialectOf(executor)): Promise<void> {
  if (dialect === 'sqlite') {
    await executor.query(`
    CREATE TABLE IF NOT EXISTS "${MIGRATION_TABLE}" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sql_hash TEXT NOT NULL,
      up_sql TEXT NOT NULL,
      down_sql TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      direction TEXT NOT NULL DEFAULT 'up'
    )
  `, [])

    return
  }

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
  executor: { query: QueryFn },
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
export async function getMigrationHistory(executor: { query: QueryFn, dialect?: Dialect }, dialect = dialectOf(executor)): Promise<MigrationHistoryEntry[]> {
  await ensureMigrationTable(executor, dialect)
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
    appliedAt: r.applied_at instanceof Date ? r.applied_at : new Date(r.applied_at as string),
    direction: r.direction as 'up' | 'down',
  }))
}

export function djb2Hash(input: string): string {
  let hash = 5381

  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i) | 0
  }

  return (hash >>> 0).toString(36)
}
