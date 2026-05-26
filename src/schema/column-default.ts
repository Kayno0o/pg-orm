import { escapeLiteralBody, quoteLiteral } from '../sql/utils'

/** Convert a JS value to a SQL DEFAULT expression based on the column's pgType. */
export function toSQLDefault(value: unknown, pgType: string): string {
  if (value === null || value === undefined)
    return 'NULL'

  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value)

  if (typeof value === 'boolean')
    return value ? 'true' : 'false'

  if (value instanceof Date)
    return `'${value.toISOString()}'`

  if (Array.isArray(value)) {
    if (value.length === 0)
      return `ARRAY[]::${pgType}`

    const items = value.map(v =>
      typeof v === 'string' ? quoteLiteral(v) : String(v),
    ).join(',')

    return `ARRAY[${items}]::${pgType}`
  }

  if (typeof value === 'object')
    return `'${escapeLiteralBody(JSON.stringify(value))}'::${pgType}`

  if (typeof value === 'string')
    return quoteLiteral(value)

  return String(value)
}
