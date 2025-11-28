import { InvalidIdentifierError } from './errors'

const SQL_IDENTIFIER_PATTERN = /^[a-z_]\w*$/i

const RESERVED_KEYWORDS = new Set([
  'ALL',
  'AND',
  'ANY',
  'AS',
  'ASC',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'CHECK',
  'COLLATE',
  'COLUMN',
  'CONSTRAINT',
  'CREATE',
  'CROSS',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'DEFAULT',
  'DELETE',
  'DESC',
  'DISTINCT',
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
  'GROUP',
  'HAVING',
  'IN',
  'INNER',
  'INSERT',
  'INTERSECT',
  'INTO',
  'IS',
  'JOIN',
  'LEFT',
  'LIKE',
  'LIMIT',
  'NOT',
  'NULL',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'PRIMARY',
  'REFERENCES',
  'RIGHT',
  'SELECT',
  'SET',
  'TABLE',
  'THEN',
  'TO',
  'TRUE',
  'UNION',
  'UNIQUE',
  'UPDATE',
  'USING',
  'VALUES',
  'WHEN',
  'WHERE',
  'WITH',
])

export function validateSQLIdentifier(
  identifier: string,
  type: 'table' | 'column' = 'table',
): void {
  if (!identifier || identifier.trim().length === 0) {
    throw new InvalidIdentifierError(type, identifier, 'identifier cannot be empty')
  }

  if (identifier.length > 63) {
    throw new InvalidIdentifierError(type, identifier, 'exceeds 63 character limit')
  }

  if (!SQL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new InvalidIdentifierError(
      type,
      identifier,
      'must start with letter or underscore and contain only letters, numbers, and underscores',
    )
  }

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
