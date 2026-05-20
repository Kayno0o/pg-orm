import { DOUBLE_QUOTE_RE } from '../utils/regex'

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
