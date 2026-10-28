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
import { outsideRunner, runOutsideTransaction, splitOutsideTransaction } from './outside'
import { planMigration } from './plan'
import { MIGRATION_LOCK_KEY } from './types'

interface MigrationExecutor { query: QueryFn, dialect: Dialect }

const SQL_EXT_RE = /\.sql$/
const MIGRATE_DOWN_RE = /^-- migrate:down[ \t]*$/gm
const MIGRATE_UP_RE = /^-- migrate:up[ \t]*(?:\n|$)/
const BOM_RE = /^\uFEFF/
const CRLF_RE = /\r\n/g
const TRAILING_LF_RE = /\n$/
const LEADING_LF_RE = /^\n/

/** A migration file's two halves, split on its `-- migrate:down` line; CRLF line endings read as LF, so a Windows checkout splits the same. */
export function parseMigrationFile(content: string, filename = 'migration file'): { up: string, down: string } {
  const text = content.replace(BOM_RE, '').replace(CRLF_RE, '\n')

  if (!MIGRATE_UP_RE.test(text))
    throw new MigrationError(`${filename} does not start with a \`-- migrate:up\` line`, 'validate', filename)

  const downs = [...text.matchAll(MIGRATE_DOWN_RE)]

  if (downs.length > 1)
    throw new MigrationError(`${filename} has ${downs.length} \`-- migrate:down\` lines, where one splits it in two`, 'validate', filename)

  const at = downs[0]?.index ?? text.length
  const up = text.slice(0, at).replace(MIGRATE_UP_RE, '').replace(TRAILING_LF_RE, '')
  const down = downs[0] ? text.slice(at + downs[0][0].length).replace(LEADING_LF_RE, '') : ''

  return { up, down }
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

// Gives back the statements a transaction refuses, for the caller to run once this one commits; the history records the whole of `up`.
async function applyAndRecord(executor: MigrationExecutor, name: string, up: string, down: string): Promise<string[]> {
  const { inside, outside } = splitOutsideTransaction(up)

  try {
    await executor.query(inside, [])
  }
  catch (err) {
    throw new MigrationError(`Migration "${name}" failed: ${err instanceof Error ? err.message : String(err)}`, 'apply', name, err)
  }

  await ensureMigrationTable(executor)
  await recordMigration(executor, { name, sqlHash: djb2Hash(up), upSql: up, downSql: down, direction: 'up' })

  return outside
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
    const { filename, outside } = await lockedMigration(db, async (executor) => {
      const next = pendingMigrationFiles(dir, await getMigrationHistory(executor))[0]

      if (next === undefined)
        return { filename: next, outside: [] }

      const { up, down } = parseMigrationFile(readFileSync(join(dir, next), 'utf8'), next)

      return { filename: next, outside: await applyAndRecord(executor, next.replace(SQL_EXT_RE, ''), up, down) }
    })

    if (filename === undefined)
      return applied

    if (outside.length > 0)
      await runOutsideTransaction(outsideRunner(db), outside)

    applied.push(filename)
  }
}

/** Generates the migration bringing the database to `registry` and, unless `dryRun`, applies and records it, all in one transaction under the migration lock; null without drift. A dry run shows destructive ops rather than refusing them. */
export async function syncMigration(
  db: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
  opts: GenerateMigrationOptions & { dryRun?: boolean } = {},
): Promise<MigrationFile | null> {
  const { file, outside } = await lockedMigration(db, async (executor) => {
    const file = migrationFile(await planMigration(executor, registry, executor.dialect, opts.schema, opts.ignoreTables), executor.dialect, opts.allowDestructive || opts.dryRun)

    return { file, outside: file && !opts.dryRun ? await applyAndRecord(executor, file.name, file.up, file.down) : [] }
  })

  if (outside.length > 0)
    await runOutsideTransaction(outsideRunner(db), outside)

  return file
}
