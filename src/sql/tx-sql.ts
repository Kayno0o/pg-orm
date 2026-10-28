import type { SQL } from 'bun'
import type { Dialect } from '../dialect'
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

export type IsolationLevel = keyof typeof ISOLATION_SQL
export type AccessMode = keyof typeof ACCESS_MODE_SQL

/** The `SET TRANSACTION …` the options ask for, undefined when they set neither isolation nor access mode. Throws `ValidationError` for unknown values. */
export function isolationStatement(opts: { isolation?: string, accessMode?: string }): string | undefined {
  const modes: string[] = []

  if (opts.isolation) {
    const isolationSql = ISOLATION_SQL[opts.isolation as IsolationLevel]

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
    const accessSql = ACCESS_MODE_SQL[opts.accessMode as AccessMode]

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

/**
 * Apply the isolation and access mode the options ask for at the start of a transaction.
 * A SQLite transaction is serializable whatever was asked, which every weaker level is satisfied by, so only a read-only access mode is applied there, as `query_only`, which the caller turns off before the commit.
 */
export async function applyIsolation(
  sqlTx: InstanceType<typeof SQL>,
  opts: { isolation?: string, accessMode?: string },
  dialect: Dialect,
): Promise<void> {
  const stmt = isolationStatement(opts)

  if (dialect === 'sqlite') {
    if (opts.accessMode === 'read only')
      await asDriver(sqlTx).unsafe('PRAGMA query_only = ON', [])
  }
  else if (stmt) {
    await asDriver(sqlTx).unsafe(stmt, [])
  }
}
