import type { AnyTableDef } from '../../types/index'
import type { MigrationOp } from '../types'
import { columnEntries } from '../types'

// The extension each type family comes from, tested against a column's printed type.
const EXTENSION_TYPES: readonly (readonly [extension: string, type: RegExp])[] = [
  ['vector', /^(?:vector|halfvec|sparsevec)\(/],
  ['citext', /^citext\b/],
]

/** `CREATE EXTENSION` for each extension the tables' types need and the live database lacks: pgvector and citext. */
export function diffExtensions(desired: ReadonlyMap<string, AnyTableDef>, live: readonly string[]): MigrationOp[] {
  const types = [...desired.values()].flatMap(table => columnEntries(table.columns).map(([, col]) => col.pgType))

  return EXTENSION_TYPES
    .filter(([extension, type]) => !live.includes(extension) && types.some(pgType => type.test(pgType)))
    .map(([extension]) => ({
      type: 'create_extension',
      sql: `CREATE EXTENSION IF NOT EXISTS "${extension}" WITH SCHEMA public`,
      destructive: false,
      description: `Create extension "${extension}"`,
    }))
}
