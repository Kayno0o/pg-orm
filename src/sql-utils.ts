import { InvalidIdentifierError } from './errors'

// ============================================================================
// SQL Identifier Validation (Defense against SQL Injection)
// ============================================================================

/**
 * PostgreSQL identifier rules:
 * - Must start with letter (a-z, A-Z) or underscore (_)
 * - Can contain letters, digits, underscores
 * - Maximum length is 63 characters
 * - Reserved keywords should be quoted, but we disallow them for safety
 */
const SQL_IDENTIFIER_PATTERN = /^[a-z_]\w*$/i

/**
 * Common PostgreSQL reserved keywords that should not be used as identifiers
 * This is a subset - full list at: https://www.postgresql.org/docs/current/sql-keywords-appendix.html
 */
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

/**
 * Validate SQL identifier (table or column name)
 * @param identifier - The identifier to validate
 * @param type - Whether this is a table or column name
 * @throws InvalidIdentifierError if validation fails
 */
export function validateSQLIdentifier(
  identifier: string,
  type: 'table' | 'column' = 'table',
): void {
  // Check for empty string
  if (!identifier || identifier.trim().length === 0) {
    throw new InvalidIdentifierError(type, identifier, 'identifier cannot be empty')
  }

  // Check length (PostgreSQL limit is 63 characters)
  if (identifier.length > 63) {
    throw new InvalidIdentifierError(type, identifier, 'exceeds 63 character limit')
  }

  // Check pattern
  if (!SQL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new InvalidIdentifierError(
      type,
      identifier,
      'must start with letter or underscore and contain only letters, numbers, and underscores',
    )
  }

  // Check for reserved keywords
  if (RESERVED_KEYWORDS.has(identifier.toUpperCase())) {
    throw new InvalidIdentifierError(
      type,
      identifier,
      `"${identifier}" is a reserved PostgreSQL keyword`,
    )
  }
}

/**
 * Safely quote a PostgreSQL identifier
 * This adds defense-in-depth by using PostgreSQL's identifier quoting
 * @param identifier - The identifier to quote
 * @returns Quoted identifier safe for use in SQL
 */
export function quoteIdentifier(identifier: string): string {
  // First validate to ensure no malicious content
  // We're paranoid and validate even though we quote
  validateSQLIdentifier(identifier)

  // PostgreSQL identifier quoting: double quotes and escape any existing double quotes
  return `"${identifier.replace(/"/g, '""')}"`
}

/**
 * Validate an array of identifiers
 * @param identifiers - Array of identifiers to validate
 * @param type - Whether these are table or column names
 */
export function validateSQLIdentifiers(
  identifiers: string[],
  type: 'table' | 'column' = 'column',
): void {
  for (const identifier of identifiers) {
    validateSQLIdentifier(identifier, type)
  }
}
