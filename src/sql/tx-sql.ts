import type { SQL } from 'bun'
import { ValidationError } from '../errors/index'
import { asDriver } from './adapter'

// --- Transaction isolation: static SQL mapping ---
// Composing SQL only from fixed strings (not user input + toUpperCase) eliminates
// any chance of injection even under future code changes.

const ISOLATION_SQL = {
  'read uncommitted': 'READ UNCOMMITTED',
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  'serializable': 'SERIALIZABLE',
} as const

const ACCESS_MODE_SQL = {
  'read write': 'READ WRITE',
  'read only': 'READ ONLY',
} as const

type IsolationLevel = keyof typeof ISOLATION_SQL
type AccessMode = keyof typeof ACCESS_MODE_SQL

/** The `SET TRANSACTION …` the options ask for, undefined when they set neither isolation nor access mode. Throws `ValidationError` for unknown values. */
export function isolationStatement(opts: { isolation?: string, accessMode?: string }): string | undefined {
  const modes: string[] = []

  if (opts.isolation) {
    const isolationSql = Object.hasOwn(ISOLATION_SQL, opts.isolation) ? ISOLATION_SQL[opts.isolation as IsolationLevel] : undefined

    if (!isolationSql) {
      throw new ValidationError(
        `Invalid isolation level: "${opts.isolation}"`,
        'transaction.isolation',
        { value: opts.isolation },
      )
    }

    modes.push(`ISOLATION LEVEL ${isolationSql}`)
  }

  if (opts.accessMode) {
    const accessSql = Object.hasOwn(ACCESS_MODE_SQL, opts.accessMode) ? ACCESS_MODE_SQL[opts.accessMode as AccessMode] : undefined

    if (!accessSql) {
      throw new ValidationError(
        `Invalid access mode: "${opts.accessMode}"`,
        'transaction.accessMode',
        { value: opts.accessMode },
      )
    }

    modes.push(accessSql)
  }

  return modes.length ? `SET TRANSACTION ${modes.join(' ')}` : undefined
}

/** The transaction modes of `isolationStatement`, as `BEGIN` takes them, undefined when the options set none. */
export function transactionModes(opts: { isolation?: string, accessMode?: string }): string | undefined {
  return isolationStatement(opts)?.slice('SET TRANSACTION '.length)
}

/**
 * Apply a read-only access mode at the start of a SQLite transaction, as `query_only`, which the caller turns off before the commit.
 * A SQLite transaction is serializable whatever was asked, which every weaker level is satisfied by; Postgres gets its modes on `BEGIN` (`transactionModes`).
 */
export async function applySqliteAccessMode(sqlTx: InstanceType<typeof SQL>, opts: { accessMode?: string }): Promise<void> {
  if (opts.accessMode === 'read only')
    await asDriver(sqlTx).unsafe('PRAGMA query_only = ON', [])
}
