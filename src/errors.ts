import { findClosestMatches } from './utils/levenshtein'
import { ValidationError } from './validation'

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

export { ValidationError } from './validation.js'

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

export function sanitizeError(error: Error, config?: { exposeInternalErrors?: boolean, includeStackTraces?: boolean }): Error {
  const shouldExpose = config?.exposeInternalErrors ?? (process.env.NODE_ENV === 'development')
  const includeStack = config?.includeStackTraces ?? (process.env.NODE_ENV === 'development')

  if (shouldExpose) {
    if (!includeStack && error.stack) {
      const sanitized = new Error(error.message)

      sanitized.name = error.name
      Object.setPrototypeOf(sanitized, Object.getPrototypeOf(error))

      return sanitized
    }

    return error
  }

  if (error instanceof EntityNotFoundError
    || error instanceof ValidationError
    || error instanceof BulkOperationError
    || error instanceof ArraySizeError
    || error instanceof StringLengthError
    || error instanceof JsonSizeError
    || error instanceof JsonDepthError
    || error instanceof InvalidColumnError
    || error instanceof InvalidIdentifierError
    || error instanceof OptimisticLockError) {
    if (!includeStack && error.stack) {
      const sanitized = new Error(error.message)

      sanitized.name = error.name
      Object.setPrototypeOf(sanitized, Object.getPrototypeOf(error))

      return sanitized
    }

    return error
  }

  const sanitized = new Error('A database error occurred. Please contact support if the issue persists.')

  sanitized.name = 'DatabaseError'

  return sanitized
}
