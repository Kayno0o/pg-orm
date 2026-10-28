import type { AnyTableDef } from '../../types/index'
import type { MigrationOp } from '../types'
import { columnEntries } from '../types'

const VECTOR_TYPE_RE = /^(?:vector|halfvec|sparsevec)\(/

/** `CREATE EXTENSION` for each extension the tables' types need and the live database lacks. Only pgvector today. */
export function diffExtensions(desired: ReadonlyMap<string, AnyTableDef>, live: readonly string[]): MigrationOp[] {
  const usesVector = [...desired.values()].some(table => columnEntries(table.columns).some(([, col]) => VECTOR_TYPE_RE.test(col.pgType)))

  if (!usesVector || live.includes('vector'))
    return []

  return [{
    type: 'create_extension',
    sql: 'CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA public',
    destructive: false,
    description: 'Create extension "vector"',
  }]
}
