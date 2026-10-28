import type { Dialect } from '../dialect'
import type { Executable } from '../sql/executor'
import type { AnyTableDef } from '../types/index'
import type { MigrationHistoryEntry } from './history'
import type { GenerateMigrationOptions } from './index'
import type { MigrationFile, MigrationOp, QueryFn } from './types'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialectOf } from '../dialect'
import { MigrationError, sanitizePgErrorMessage } from '../errors/index'
import { appliedSqlMatches, ensureMigrationTable, getMigrationHistory, recordMigration, sqlHash } from './history'
import { migrationFile } from './index'
import { enumAdditions, outsideRunner, runOutsideTransaction, splitOutsideTransaction } from './outside'
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

/** The `.sql` files of `dir` against the history, each list in name order. */
export interface MigrationFilesState {
  /** Not applied, or rolled back as often as applied. */
  pending: string[]
  /** Applied, their `up` changed since. */
  edited: string[]
  /** Pending, sorting before the last applied file: applying them would run them after migrations they predate. */
  outOfOrder: string[]
}

export function migrationFilesState(dir: string, history: MigrationHistoryEntry[]): MigrationFilesState {
  const state: MigrationFilesState = { pending: [], edited: [], outOfOrder: [] }

  if (!existsSync(dir))
    return state

  // Per name, the up applied last while it stands: a down cancels the up before it.
  const applied = new Map<string, MigrationHistoryEntry[]>()

  for (const entry of history) {
    const ups = applied.get(entry.name) ?? []

    if (entry.direction === 'up')
      ups.push(entry)
    else
      ups.pop()

    applied.set(entry.name, ups)
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  // The last applied file: a `db.sync()` records a migration with no file, which a file named by hand need not sort after.
  const last = files.findLast(file => applied.get(file.replace(SQL_EXT_RE, ''))?.length)?.replace(SQL_EXT_RE, '') ?? ''

  for (const file of files) {
    const name = file.replace(SQL_EXT_RE, '')
    const up = applied.get(name)?.at(-1)

    if (!up) {
      state.pending.push(file)

      if (name < last)
        state.outOfOrder.push(file)
    }
    else if (!appliedSqlMatches(up, parseMigrationFile(readFileSync(join(dir, file), 'utf8'), file).up)) {
      state.edited.push(file)
    }
  }

  return state
}

// Applying past an edited or out-of-order file would leave the database matching no history, so apply refuses both.
export function refuseInconsistent(state: MigrationFilesState): void {
  if (state.edited.length > 0)
    throw new MigrationError(`Applied migration file(s) changed since they ran: ${state.edited.join(', ')}. Restore them, and put the change in a new migration.`, 'validate', state.edited[0])

  if (state.outOfOrder.length > 0)
    throw new MigrationError(`Pending migration file(s) sort before a file already applied: ${state.outOfOrder.join(', ')}. Rename them to sort after the last applied file.`, 'validate', state.outOfOrder[0])
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

async function runMigrationSql(executor: MigrationExecutor, name: string, sql: string): Promise<void> {
  try {
    await executor.query(sql, [])
  }
  catch (err) {
    throw new MigrationError(`Migration "${name}" failed: ${sanitizePgErrorMessage(err instanceof Error ? err.message : String(err))}`, 'apply', name, err)
  }
}

// Gives back the statements a transaction refuses, for the caller to run once this one commits; the history records the whole of `up`.
async function applyAndRecord(executor: MigrationExecutor, name: string, up: string, down: string): Promise<string[]> {
  const { inside, outside } = splitOutsideTransaction(up)

  await runMigrationSql(executor, name, inside)
  await ensureMigrationTable(executor)
  await recordMigration(executor, { name, sqlHash: sqlHash(up), upSql: up, downSql: down, direction: 'up' })

  return outside
}

/** The files of `dir` against the history read in the configured schema: pending, edited since applied, and out of order. */
export async function migrationFiles(db: Executable, dir: string): Promise<MigrationFilesState> {
  return lockedMigration(db, async executor => migrationFilesState(dir, await getMigrationHistory(executor)))
}

/**
 * Applies the pending files of `dir` in name order; gives their file names.
 * Each file is applied and recorded in one transaction under the migration lock, the history read again under it, so a file another process applied meanwhile is skipped and a failed one leaves no trace.
 * An applied file edited since, or a pending one sorting before an applied migration, throws `MigrationError` before anything runs.
 */
export async function applyMigrationFiles(db: Executable, dir: string): Promise<string[]> {
  const applied: string[] = []
  // Files whose enum additions committed already, which the next pass applies whole.
  const enumsAdded = new Set<string>()

  for (;;) {
    const { filename, outside, retry } = await lockedMigration(db, async (executor) => {
      const state = migrationFilesState(dir, await getMigrationHistory(executor))

      refuseInconsistent(state)

      const next = state.pending[0]

      if (next === undefined)
        return { filename: next, outside: [] }

      const { up, down } = parseMigrationFile(readFileSync(join(dir, next), 'utf8'), next)
      const additions = enumsAdded.has(next) ? [] : enumAdditions(up)

      // A value an enum gains cannot be used in the transaction adding it: the additions commit on their own, the next pass applies the file.
      if (additions.length > 0) {
        await runMigrationSql(executor, next.replace(SQL_EXT_RE, ''), additions.join('\n'))
        enumsAdded.add(next)

        return { filename: next, outside: [], retry: true }
      }

      return { filename: next, outside: await applyAndRecord(executor, next.replace(SQL_EXT_RE, ''), up, down) }
    })

    if (filename === undefined)
      return applied

    if (retry)
      continue

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
  const plan = (executor: MigrationExecutor): Promise<MigrationOp[]> => planMigration(executor, registry, executor.dialect, opts.schema, opts.ignoreTables)
  // A value an enum gains cannot be used in the transaction adding it: the additions commit first, once the plan passed the destructive gate, and the file still lists them.
  const added = opts.dryRun
    ? []
    : await lockedMigration(db, async (executor) => {
      const ops = await plan(executor)
      const additions = ops.filter(o => o.type === 'alter_enum_add')

      migrationFile(ops, executor.dialect, opts.allowDestructive)

      if (additions.length > 0)
        await runMigrationSql(executor, 'sync', additions.map(o => `${o.sql};`).join('\n'))

      return additions
    })

  const { file, outside } = await lockedMigration(db, async (executor) => {
    const ops = [...added, ...(await plan(executor)).filter(o => o.type !== 'alter_enum_add')]
    const file = migrationFile(ops, executor.dialect, opts.allowDestructive || opts.dryRun)

    return { file, outside: file && !opts.dryRun ? await applyAndRecord(executor, file.name, file.up, file.down) : [] }
  })

  if (outside.length > 0)
    await runOutsideTransaction(outsideRunner(db), outside)

  return file
}
