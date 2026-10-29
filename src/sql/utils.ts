import { DOUBLE_QUOTE_RE, SINGLE_QUOTE_RE } from '../utils/regex'

/**
 * Safely quote a PostgreSQL identifier (table, column, etc.)
 * Handles internal double quotes by escaping them as "".
 */
export function quote(name: string): string {
  return name === '*' ? '*' : `"${name.replace(DOUBLE_QUOTE_RE, '""')}"`
}

/**
 * Safely quote a dot-separated path (e.g. "table.column")
 */
export function quotePath(path: string): string {
  return path.split('.').map(quote).join('.')
}

/** A column as SQL: `alias.col` names a joined table's column, a bare one is prefixed with `qualifier` when given. */
export function qualifyCol(col: string, qualifier?: string): string {
  if (col.includes('.'))
    return quotePath(col)

  return qualifier ? `${quote(qualifier)}.${quote(col)}` : quote(col)
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
