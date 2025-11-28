import type { ValidationErrorDetail } from './types'
import { findClosestMatches } from './utils/levenshtein'

// ============================================================================
// Entity Errors
// ============================================================================

/**
 * Thrown when an entity is not found by ID
 * @example
 * ```ts
 * try {
 *   await users.find(999)
 * } catch (error) {
 *   if (error instanceof EntityNotFoundError) {
 *     console.log(error.entityName) // 'users'
 *     console.log(error.id) // 999
 *   }
 * }
 * ```
 */
export class EntityNotFoundError extends Error {
  constructor(
    public entityName: string,
    public id: number | Record<string, unknown>,
    public context?: {
      totalCount?: number
      lastValidId?: number
      suggestion?: string
    },
  ) {
    const idStr = typeof id === 'number' ? id.toString() : JSON.stringify(id)
    let message = `${entityName} with id ${idStr} not found`

    if (context) {
      if (context.totalCount !== undefined) {
        message += `\nAvailable entities: ${context.totalCount}`
      }

      if (context.lastValidId !== undefined) {
        message += `\nLast valid ID: ${context.lastValidId}`
      }

      if (context.suggestion) {
        message += `\nSuggestion: ${context.suggestion}`
      }
    }

    super(message)
    this.name = 'EntityNotFoundError'
  }
}

// ============================================================================
// Validation Errors
// ============================================================================

/**
 * Thrown when entity data fails validation
 * @example
 * ```ts
 * try {
 *   await users.create({ name: 'X', email: 'invalid' })
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     console.log(error.violations) // Array of validation errors
 *   }
 * }
 * ```
 */
export class ValidationError extends Error {
  constructor(
    public entityName: string,
    public violations: ValidationErrorDetail[],
  ) {
    const messages = violations.map(v => `${v.field}: ${v.message}`).join(', ')

    super(`Validation failed for ${entityName}: ${messages}`)
    this.name = 'ValidationError'
  }
}

/** Thrown when optimistic locking detects concurrent modification */
export class OptimisticLockError extends Error {
  constructor(
    public entityName: string,
    public id: number,
    public expectedVersion: number,
    public actualVersion: number,
  ) {
    super(
      `Optimistic lock failed for ${entityName} with id ${id}. `
      + `Expected version ${expectedVersion}, got ${actualVersion}`,
    )
    this.name = 'OptimisticLockError'
  }
}

// ============================================================================
// Database Errors
// ============================================================================

/** Thrown when a database query fails */
export class QueryError extends Error {
  declare query?: string
  declare cause?: Error

  constructor(
    message: string,
    query?: string,
    cause?: Error,
  ) {
    super(message)
    this.name = 'QueryError'
    this.query = query
    this.cause = cause
  }
}

/** Thrown when a general database error occurs */
export class DatabaseError extends Error {
  declare cause?: Error

  constructor(
    message: string,
    cause?: Error,
  ) {
    super(message)
    this.name = 'DatabaseError'
    this.cause = cause
  }
}

// ============================================================================
// Security Errors
// ============================================================================

/**
 * Thrown when a table or column identifier is invalid
 * Prevents SQL injection through identifier manipulation
 * @example
 * ```ts
 * // ❌ Throws InvalidIdentifierError
 * orm.entity('users; DROP TABLE users; --', { ... })
 * ```
 */
export class InvalidIdentifierError extends Error {
  constructor(
    public identifierType: 'table' | 'column',
    public identifier: string,
    public reason?: string,
  ) {
    const reasonMsg = reason ? `: ${reason}` : ''

    super(
      `Invalid ${identifierType} identifier "${identifier}"${reasonMsg}. `
      + `Identifiers must match pattern ^[a-zA-Z_][a-zA-Z0-9_]*$ and be <= 63 characters.`,
    )
    this.name = 'InvalidIdentifierError'
  }
}

/**
 * Thrown when querying an invalid column name
 * Includes suggestions for similar column names
 */
export class InvalidColumnError extends Error {
  constructor(
    public column: string,
    public tableName: string,
    public validColumns: string[],
  ) {
    const suggestions = findClosestMatches(column, validColumns, 2)
    let message = `Invalid column '${column}' in table '${tableName}'.\n`

    message += `Valid columns: ${validColumns.join(', ')}`

    if (suggestions.length > 0) {
      message += `\nDid you mean: ${suggestions.join(', ')}?`
    }

    super(message)
    this.name = 'InvalidColumnError'
  }
}

// ============================================================================
// DoS Protection Errors
// ============================================================================

/**
 * Thrown when a bulk operation exceeds configured limits
 * Prevents DoS attacks via excessive batch operations
 * @example
 * ```ts
 * // With limit of 1000
 * await users.createMany(arrayOf10000Items) // ❌ Throws BulkOperationError
 * ```
 */
export class BulkOperationError extends Error {
  constructor(
    public operation: string,
    public attempted: number,
    public limit: number,
  ) {
    super(
      `Bulk operation '${operation}' exceeds limit of ${limit} items (attempted: ${attempted}).\n`
      + `Suggestion: Process in batches of ${limit} items or fewer.`,
    )
    this.name = 'BulkOperationError'
  }
}

/**
 * Thrown when an array field exceeds size limits
 * Prevents DoS attacks via excessive array sizes
 */
export class ArraySizeError extends Error {
  constructor(
    public field: string,
    public size: number,
    public limit: number,
  ) {
    super(
      `Array field '${field}' exceeds size limit of ${limit} items (got: ${size}).\n`
      + `Suggestion: Consider pagination or splitting the data.`,
    )
    this.name = 'ArraySizeError'
  }
}

/**
 * Thrown when a string field exceeds length limits
 * Prevents DoS attacks via excessive string lengths
 */
export class StringLengthError extends Error {
  constructor(
    public field: string,
    public length: number,
    public limit: number,
  ) {
    super(
      `String field '${field}' exceeds length limit of ${limit} characters (got: ${length}).\n`
      + `Suggestion: Consider using a TEXT or BLOB field for large content.`,
    )
    this.name = 'StringLengthError'
  }
}

/**
 * Thrown when a JSON field exceeds size limits
 * Prevents DoS attacks via excessive JSON payload sizes
 */
export class JsonSizeError extends Error {
  constructor(
    public field: string,
    public size: number,
    public limit: number,
  ) {
    super(
      `JSON field '${field}' exceeds size limit of ${limit} bytes (got: ${size}).\n`
      + `Suggestion: Consider splitting the JSON or using a separate storage solution.`,
    )
    this.name = 'JsonSizeError'
  }
}

/**
 * Thrown when a JSON field exceeds nesting depth limits
 * Prevents DoS attacks via deeply nested JSON causing stack overflow
 * @example
 * ```ts
 * // With default limit of 32 levels
 * let deep = { value: 1 }
 * for (let i = 0; i < 40; i++) deep = { nested: deep }
 * await users.create({ metadata: deep }) // ❌ Throws JsonDepthError
 * ```
 */
export class JsonDepthError extends Error {
  constructor(
    public field: string,
    public depth: number,
    public limit: number,
  ) {
    super(
      `JSON field '${field}' exceeds nesting depth limit of ${limit} levels (got: ${depth}).\n`
      + `Suggestion: Flatten the JSON structure or split into multiple fields.`,
    )
    this.name = 'JsonDepthError'
  }
}
