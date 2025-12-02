import { InvalidIdentifierError } from './errors'

// PostgreSQL identifier pattern: must start with letter or underscore,
// followed by letters, numbers, underscores only (no hyphens, spaces, or special chars)
const SQL_IDENTIFIER_PATTERN = /^[a-z_]\w*$/i

// PostgreSQL reserved keywords (expanded list including common SQL keywords)
const RESERVED_KEYWORDS = new Set([
  'ALL',
  'ANALYSE',
  'ANALYZE',
  'AND',
  'ANY',
  'ARRAY',
  'AS',
  'ASC',
  'ASYMMETRIC',
  'AUTHORIZATION',
  'BETWEEN',
  'BINARY',
  'BOTH',
  'BY',
  'CASE',
  'CAST',
  'CHECK',
  'COLLATE',
  'COLLATION',
  'COLUMN',
  'CONCURRENTLY',
  'CONSTRAINT',
  'CREATE',
  'CROSS',
  'CURRENT_CATALOG',
  'CURRENT_DATE',
  'CURRENT_ROLE',
  'CURRENT_SCHEMA',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'CURRENT_USER',
  'DEFAULT',
  'DEFERRABLE',
  'DELETE',
  'DESC',
  'DISTINCT',
  'DO',
  'DROP',
  'ELSE',
  'END',
  'EXCEPT',
  'EXISTS',
  'FALSE',
  'FETCH',
  'FOR',
  'FOREIGN',
  'FROM',
  'FULL',
  'GRANT',
  'GROUP',
  'HAVING',
  'ILIKE',
  'IN',
  'INITIALLY',
  'INNER',
  'INSERT',
  'INTERSECT',
  'INTO',
  'IS',
  'ISNULL',
  'JOIN',
  'LATERAL',
  'LEADING',
  'LEFT',
  'LIKE',
  'LIMIT',
  'LOCALTIME',
  'LOCALTIMESTAMP',
  'NOT',
  'NOTNULL',
  'NULL',
  'OFFSET',
  'ON',
  'ONLY',
  'OR',
  'ORDER',
  'OUTER',
  'OVERLAPS',
  'PLACING',
  'PRIMARY',
  'REFERENCES',
  'RETURNING',
  'RIGHT',
  'SELECT',
  'SESSION_USER',
  'SET',
  'SIMILAR',
  'SOME',
  'SYMMETRIC',
  'TABLE',
  'TABLESAMPLE',
  'THEN',
  'TO',
  'TRAILING',
  'TRUE',
  'UNION',
  'UNIQUE',
  'UPDATE',
  'USER',
  'USING',
  'VALUES',
  'VARIADIC',
  'VERBOSE',
  'WHEN',
  'WHERE',
  'WINDOW',
  'WITH',
])

export function validateSQLIdentifier(
  identifier: string,
  type: 'table' | 'column' = 'table',
): void {
  // Check for empty/whitespace-only identifiers
  if (!identifier || identifier.trim().length === 0) {
    throw new InvalidIdentifierError(type, identifier, 'identifier cannot be empty')
  }

  // Check identifier is the same as trimmed (no leading/trailing whitespace)
  if (identifier !== identifier.trim()) {
    throw new InvalidIdentifierError(type, identifier, 'identifier cannot have leading or trailing whitespace')
  }

  // PostgreSQL identifier length limit is 63 bytes (NAMEDATALEN - 1)
  if (identifier.length > 63) {
    throw new InvalidIdentifierError(type, identifier, 'exceeds PostgreSQL 63 character limit (NAMEDATALEN)')
  }

  // Check for dangerous characters that could be used for injection
  if (identifier.includes('--') || identifier.includes('/*') || identifier.includes('*/')) {
    throw new InvalidIdentifierError(type, identifier, 'identifier cannot contain SQL comment sequences')
  }

  if (identifier.includes(';')) {
    throw new InvalidIdentifierError(type, identifier, 'identifier cannot contain semicolons')
  }

  // Validate pattern: alphanumeric + underscore only, must start with letter or underscore
  if (!SQL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new InvalidIdentifierError(
      type,
      identifier,
      'must start with letter or underscore and contain only letters, numbers, and underscores',
    )
  }

  // Check against reserved keywords
  if (RESERVED_KEYWORDS.has(identifier.toUpperCase())) {
    throw new InvalidIdentifierError(
      type,
      identifier,
      `"${identifier}" is a reserved PostgreSQL keyword`,
    )
  }
}

export function quoteIdentifier(identifier: string): string {
  validateSQLIdentifier(identifier)

  return `"${identifier.replace(/"/g, '""')}"`
}

export function validateSQLIdentifiers(
  identifiers: string[],
  type: 'table' | 'column' = 'column',
): void {
  for (const identifier of identifiers) {
    validateSQLIdentifier(identifier, type)
  }
}
