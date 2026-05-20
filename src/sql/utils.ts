import { DOUBLE_QUOTE_RE, SINGLE_QUOTE_RE } from '../utils/regex'

/**
 * Safely quote a PostgreSQL identifier (table, column, etc.)
 * Handles internal double quotes by escaping them as "".
 */
export function quote(name: string): string {
  if (name === '*')
    return '*'

  return `"${name.replace(DOUBLE_QUOTE_RE, '""')}"`
}

/**
 * Safely quote a dot-separated path (e.g. "table.column")
 */
export function quotePath(path: string): string {
  return path.split('.').map(quote).join('.')
}

/**
 * Escape a string value for embedding as a SQL literal — doubles single quotes.
 * Returns the value wrapped in single quotes. Use only in DDL where parameter
 * binding isn't supported; prefer bound params for DML.
 */
export function quoteLiteral(val: string): string {
  return `'${val.replace(SINGLE_QUOTE_RE, '\'\'')}'`
}

/**
 * Like `quoteLiteral`, but returns just the escaped contents (no surrounding
 * quotes). Useful when the caller already provides quoting (e.g. `'${...}'::type`).
 */
export function escapeLiteralBody(val: string): string {
  return val.replace(SINGLE_QUOTE_RE, '\'\'')
}

/**
 * Build a comma-separated list of positional placeholders: `$1, $2, $3`.
 * Returns an empty string when `n` is 0.
 */
export function buildPlaceholders(n: number, startIndex = 1): string {
  if (n === 0)
    return ''

  const parts: string[] = []

  for (let i = 0; i < n; i++) parts.push(`$${startIndex + i}`)

  return parts.join(', ')
}
