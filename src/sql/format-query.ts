import type { QueryEvent } from './base-executor'
import type { DbConfig } from './config'
import { logParams, queryLogsRedacted } from '../errors/index'
import { SINGLE_QUOTE_RE, SQL_PLACEHOLDER_RE } from '../utils/regex'

export interface FormatQueryOptions {
  /** Wrap the duration and the inlined params in ANSI colors (default: false). */
  colors?: boolean
  /** Truncate each rendered param past this many characters (default: 120, `0` disables). */
  maxParamLength?: number
  /** Prefix the line with `[1.234ms]` (default: true). */
  duration?: boolean
}

const DEFAULT_MAX_PARAM_LENGTH = 120

const DIM = '\x1B[2m'
const YELLOW = '\x1B[33m'
const RESET = '\x1B[0m'

/**
 * Render a `QueryEvent` as a single copy-pasteable log line: the SQL with its
 * `$n` placeholders replaced by the literal values that were bound.
 *
 * The output is for humans. It is **not** valid SQL to re-execute against a
 * database with untrusted values - it exists so you can read what ran.
 *
 * Redaction is inherited from the error layer: when `NODE_ENV=production` or
 * `REDACT_QUERY_LOGS=1` the whole line is `[REDACTED]`, and a `redactParams`
 * redactor (see `DbConfig.redactParams`) is applied to the values first.
 * `REDACT_QUERY_LOGS=0` renders the raw values, in production too.
 *
 * @example
 * ```ts
 * const db = new Database({ onQuery: e => logger.debug(formatQuery(e)) })
 * // [0.412ms] SELECT * FROM "users" WHERE "email" = 'alice@example.com'
 * ```
 */
export function formatQuery(event: QueryEvent, opts: FormatQueryOptions = {}): string {
  const { colors = false, maxParamLength = DEFAULT_MAX_PARAM_LENGTH, duration = true } = opts
  const prefix = duration && Number.isFinite(event.durationMs)
    ? `${colors ? DIM : ''}[${event.durationMs.toFixed(3)}ms]${colors ? RESET : ''} `
    : ''

  if (queryLogsRedacted())
    return `${prefix}[REDACTED]`

  const params = logParams(event.params)

  const sql = event.sql.replace(SQL_PLACEHOLDER_RE, (match, index: string) => {
    const param = params[Number(index) - 1]

    if (param === undefined && Number(index) > params.length)
      return match

    const rendered = renderParam(param, maxParamLength)

    return colors ? `${YELLOW}${rendered}${RESET}` : rendered
  })

  return prefix + sql
}

/**
 * Build the effective `onQuery` handler for a `DbConfig`: the user's own
 * handler, optionally followed by a `formatQuery` line when `debug` is on.
 * Returns `onQuery` untouched when `debug` is off. Whether query logs are redacted is decided per query, as for the events themselves, so the sink writes nothing while they are.
 */
export function composeQueryLogger(
  debug: DbConfig['debug'],
  onQuery: ((event: QueryEvent) => void) | undefined,
): ((event: QueryEvent) => void) | undefined {
  if (!debug)
    return onQuery

  const sink = typeof debug === 'function' ? debug : (line: string) => console.log(line)
  // Colors only for the built-in console sink — a custom sink usually feeds a
  // structured logger that would store the escape codes verbatim.
  const colors = typeof debug !== 'function' && Boolean(process.stdout?.isTTY)

  return (event) => {
    onQuery?.(event)

    if (!queryLogsRedacted())
      sink(formatQuery(event, { colors }))
  }
}

/**
 * Render a bound param as the SQL literal it stands for. `max` truncates the
 * contents of quoted literals so the quoting stays balanced.
 */
function renderParam(value: unknown, max: number): string {
  if (value === null || value === undefined)
    return 'NULL'

  switch (typeof value) {
    case 'number':
    case 'bigint':
      return String(value)
    case 'boolean':
      return value ? 'TRUE' : 'FALSE'
    case 'string':
      return quote(value, max)
  }

  if (value instanceof Date)
    return quote(value.toISOString(), max)

  if (value instanceof Uint8Array)
    return quote(`\\x${value.toHex()}`, max)

  try {
    return quote(JSON.stringify(value) ?? String(value), max)
  }
  catch {
    return quote(String(value), max)
  }
}

function quote(value: string, max: number): string {
  const truncated = max > 0 && value.length > max ? `${value.slice(0, max)}...` : value

  return `'${truncated.replace(SINGLE_QUOTE_RE, '\'\'')}'`
}
