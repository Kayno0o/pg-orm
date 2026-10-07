import type { Executable } from '../sql/executor'
import type { MigrationHistoryEntry } from './history'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { djb2Hash, ensureMigrationTable, getMigrationHistory, recordMigration } from './history'
import { applyMigration } from './index'

const SQL_EXT_RE = /\.sql$/
const MIGRATE_DOWN_RE = /\n-- migrate:down\n/
const MIGRATE_UP_RE = /^-- migrate:up\n/

/** A migration file's two halves, split on its `-- migrate:down` line. */
export function parseMigrationFile(content: string): { up: string, down: string } {
  const [up = '', down = ''] = content.split(MIGRATE_DOWN_RE)

  return { up: up.replace(MIGRATE_UP_RE, ''), down }
}

/** The `.sql` files of `dir` the history has not applied, or has rolled back as often as it applied them, in name order. */
export function pendingMigrationFiles(dir: string, history: MigrationHistoryEntry[]): string[] {
  if (!existsSync(dir))
    return []

  return readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .filter((f) => {
      const name = f.replace(SQL_EXT_RE, '')
      const ups = history.filter(h => h.name === name && h.direction === 'up').length
      const downs = history.filter(h => h.name === name && h.direction === 'down').length

      return ups <= downs
    })
}

/** Applies the pending files of `dir` in name order, each recorded in the history as it lands; gives their file names. */
export async function applyMigrationFiles(db: Executable, dir: string): Promise<string[]> {
  await ensureMigrationTable(db)

  const pending = pendingMigrationFiles(dir, await getMigrationHistory(db))

  for (const filename of pending) {
    const { up, down } = parseMigrationFile(readFileSync(join(dir, filename), 'utf8'))

    await applyMigration(db, up)
    await recordMigration(db, { name: filename.replace(SQL_EXT_RE, ''), sqlHash: djb2Hash(up), upSql: up, downSql: down, direction: 'up' })
  }

  return pending
}
