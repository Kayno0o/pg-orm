import type { DatabaseColumn, PostgresType } from '../migration/types'

export default function (column: DatabaseColumn): PostgresType {
  // Handle array types
  if (column.udtName.startsWith('_')) {
    switch (column.udtName) {
    case '_text':
      return 'TEXT[]'
    case '_int4':
    case '_int8':
      return 'INTEGER[]'
    case '_bool':
      return 'BOOLEAN[]'
    }
  }

  // Handle standard types
  switch (column.dataType.toUpperCase()) {
  case 'CHARACTER VARYING':
    return column.characterMaximumLength ? `VARCHAR(${column.characterMaximumLength})` : 'VARCHAR'
  case 'TEXT':
    return 'TEXT'
  case 'INTEGER':
  case 'BIGINT':
    return 'INTEGER'
  case 'DOUBLE PRECISION':
  case 'REAL':
    return 'DOUBLE PRECISION'
  case 'BOOLEAN':
    return 'BOOLEAN'
  case 'JSON':
    return 'JSON'
  case 'JSONB':
    return 'JSONB'
  case 'UUID':
    return 'UUID'
  case 'TIMESTAMP WITH TIME ZONE':
  case 'TIMESTAMP WITHOUT TIME ZONE':
    return 'TIMESTAMP WITH TIME ZONE'
  case 'DATE':
    return 'DATE'
  case 'BYTEA':
    return 'BYTEA'
  default:
    return column.dataType.toUpperCase() as PostgresType
  }
}
