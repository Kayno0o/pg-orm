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

export type IsolationLevel = keyof typeof ISOLATION_SQL
export type AccessMode = keyof typeof ACCESS_MODE_SQL

/**
 * Emit `SET TRANSACTION ISOLATION LEVEL …` for the given options on a per-tx
 * sql tag. No-op when isolation isn't set. Validates inputs and throws
 * `ValidationError` for unknown values.
 */
export async function applyIsolation(
  sqlTx: InstanceType<typeof SQL>,
  opts: { isolation?: string, accessMode?: string },
): Promise<void> {
  if (!opts.isolation)
    return

  const isolationSql = ISOLATION_SQL[opts.isolation as IsolationLevel]

  if (!isolationSql) {
    throw new ValidationError(
      `Invalid isolation level: "${opts.isolation}"`,
      'transaction.isolation',
      { value: opts.isolation },
    )
  }

  let stmt = `SET TRANSACTION ISOLATION LEVEL ${isolationSql}`

  if (opts.accessMode) {
    const accessSql = ACCESS_MODE_SQL[opts.accessMode as AccessMode]

    if (!accessSql) {
      throw new ValidationError(
        `Invalid access mode: "${opts.accessMode}"`,
        'transaction.accessMode',
        { value: opts.accessMode },
      )
    }

    stmt += ` ${accessSql}`
  }

  await asDriver(sqlTx).unsafe(stmt, [])
}

/**
 * Emit transaction-local `statement_timeout` via `set_config(..., true)`.
 * The PG setting name is a bound param, so the value can never be injected
 * as SQL text.
 */
export async function applyStatementTimeout(
  sqlTx: InstanceType<typeof SQL>,
  ms: number,
): Promise<void> {
  await asDriver(sqlTx).unsafe(
    'SELECT set_config($1, $2, true)',
    ['statement_timeout', String(Math.floor(ms))],
  )
}

/**
 * Emit transaction-local `idle_in_transaction_session_timeout`. Same shape as
 * `applyStatementTimeout`.
 */
export async function applyIdleInTransactionTimeout(
  sqlTx: InstanceType<typeof SQL>,
  ms: number,
): Promise<void> {
  await asDriver(sqlTx).unsafe(
    'SELECT set_config($1, $2, true)',
    ['idle_in_transaction_session_timeout', String(Math.floor(ms))],
  )
}
