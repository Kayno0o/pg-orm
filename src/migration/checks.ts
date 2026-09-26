import type { AnyColumnDef } from '../types/index'
import { getColumnMeta } from '../schema/column-meta'
import { escapeLiteralBody } from '../sql/utils'

// PG truncates longer identifiers, which would make a name never match the one it was created with.
const MAX_IDENTIFIER_BYTES = 63
const HASH_LENGTH = 8

// A name this module generated: `<table>_<column>_check_<hash>`, the prefix possibly truncated.
export const HASHED_CHECK_RE = /_check_[0-9a-f]{8}$/

export interface ColumnCheck {
  name: string
  expr: string
}

/**
 * The CHECK constraints a column declares: its `.check()` expressions, then one built from its validation metadata (`min`, `pattern`, ...).
 * Each is named after a hash of its expression, so `sync()` tells a changed check from an unchanged one by name alone.
 */
export function columnChecks(tableName: string, colName: string, colDef: AnyColumnDef): ColumnCheck[] {
  const exprs = colDef.constraints.flatMap(c => c.type === 'check' ? [String(c.value)] : [])
  const meta = getColumnMeta(colDef)
  const parts: string[] = []

  if (meta.min != null)
    parts.push(`"${colName}" >= ${meta.min}`)

  if (meta.max != null)
    parts.push(`"${colName}" <= ${meta.max}`)

  if (meta.minLength != null)
    parts.push(`length("${colName}") >= ${meta.minLength}`)

  if (meta.maxLength != null)
    parts.push(`length("${colName}") <= ${meta.maxLength}`)

  if (meta.pattern != null)
    parts.push(`"${colName}" ~ '${escapeLiteralBody(meta.pattern)}'`)

  if (meta.oneOf != null) {
    const vals = meta.oneOf.map(v => typeof v === 'string' ? `'${escapeLiteralBody(v)}'` : String(v)).join(', ')

    parts.push(`"${colName}" IN (${vals})`)
  }

  if (parts.length > 0)
    exprs.push(parts.join(' AND '))

  const unique = [...new Set(exprs)]

  return unique.map(expr => ({ name: checkName(tableName, colName, expr), expr }))
}

function checkName(tableName: string, colName: string, expr: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(expr).digest('hex').slice(0, HASH_LENGTH)
  const suffix = `_check_${hash}`

  return `${`${tableName}_${colName}`.slice(0, MAX_IDENTIFIER_BYTES - suffix.length)}${suffix}`
}
