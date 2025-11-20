import type { ValidationErrorDetail } from './types'

export class EntityNotFoundError extends Error {
  constructor(
    public entityName: string,
    public id: number | Record<string, unknown>,
  ) {
    const idStr = typeof id === 'number' ? id.toString() : JSON.stringify(id)

    super(`${entityName} with id ${idStr} not found`)
    this.name = 'EntityNotFoundError'
  }
}

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
