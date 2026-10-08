import type { Dialect } from '../dialect'
import type { Executable } from '../sql/executor'
import type { AnyTableDef } from '../types/index'
import type { MigrationHistoryEntry } from './history'
import type { GenerateMigrationOptions } from './index'
import type { MigrationFile, QueryFn } from './types'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialectOf } from '../dialect'
import { MigrationError } from '../errors/index'
import { djb2Hash, ensureMigrationTable, getMigrationHistory, recordMigration } from './history'
import { migrationFile } from './index'
import { planMigration } from './plan'
import { MIGRATION_LOCK_KEY } from './types'

interface MigrationExecutor { query: QueryFn, dialect: Dialect }

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

// Runs `fn` in one migration transaction, which resolves names in the configured schema, holding the lock every migration takes so two processes never interleave; an executor without `migrate` runs it as is.
function lockedMigration<T>(db: Executable, fn: (executor: MigrationExecutor) => Promise<T>): Promise<T> {
  const dialect = dialectOf(db)
  const run = async (query: QueryFn): Promise<T> => {
    if (dialect === 'postgres')
      await query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY])

    return fn({ query, dialect })
  }

  return db.migrate ? db.migrate(run) : run(db.query)
}

async function applyAndRecord(executor: MigrationExecutor, name: string, up: string, down: string): Promise<void> {
  try {
    await executor.query(up, [])
  }
  catch (err) {
    throw new MigrationError(`Migration "${name}" failed: ${err instanceof Error ? err.message : String(err)}`, 'apply', name, err)
  }

  await ensureMigrationTable(executor)
  await recordMigration(executor, { name, sqlHash: djb2Hash(up), upSql: up, downSql: down, direction: 'up' })
}

/** The files of `dir` not applied yet, the history read in the configured schema. */
export async function pendingMigrations(db: Executable, dir: string): Promise<string[]> {
  return lockedMigration(db, async executor => pendingMigrationFiles(dir, await getMigrationHistory(executor)))
}

/**
 * Applies the pending files of `dir` in name order; gives their file names.
 * Each file is applied and recorded in one transaction under the migration lock, the history read again under it, so a file another process applied meanwhile is skipped and a failed one leaves no trace.
 */
export async function applyMigrationFiles(db: Executable, dir: string): Promise<string[]> {
  const applied: string[] = []

  for (;;) {
    const filename = await lockedMigration(db, async (executor) => {
      const next = pendingMigrationFiles(dir, await getMigrationHistory(executor))[0]

      if (next !== undefined) {
        const { up, down } = parseMigrationFile(readFileSync(join(dir, next), 'utf8'))

        await applyAndRecord(executor, next.replace(SQL_EXT_RE, ''), up, down)
      }

      return next
    })

    if (filename === undefined)
      return applied

    applied.push(filename)
  }
}

/** Generates the migration bringing the database to `registry` and, unless `dryRun`, applies and records it, all in one transaction under the migration lock; null without drift. A dry run shows destructive ops rather than refusing them. */
export async function syncMigration(
  db: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
  opts: GenerateMigrationOptions & { dryRun?: boolean } = {},
): Promise<MigrationFile | null> {
  return lockedMigration(db, async (executor) => {
    const file = migrationFile(await planMigration(executor, registry, executor.dialect, opts.schema, opts.ignoreTables), executor.dialect, opts.allowDestructive || opts.dryRun)

    if (file && !opts.dryRun)
      await applyAndRecord(executor, file.name, file.up, file.down)

    return file
  })
}
