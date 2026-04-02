const QUOTE_RE = /"/g

/**
 * Safely quote a PostgreSQL identifier (table, column, etc.)
 * Handles internal double quotes by escaping them as "".
 */
export function quote(name: string): string {
  if (name === '*')
    return '*'

  return `"${name.replace(QUOTE_RE, '""')}"`
}

/**
 * Safely quote a dot-separated path (e.g. "table.column")
 */
export function quotePath(path: string): string {
  return path.split('.').map(quote).join('.')
}
