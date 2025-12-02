import {
  ForeignKeyConstraintViolationError,
  NotNullConstraintViolationError,
  UniqueConstraintViolationError,
} from '../errors'

interface PostgresError extends Error {
  code?: string
  constraint?: string
  table?: string
  column?: string
  detail?: string
}

function isPostgresError(error: unknown): error is PostgresError {
  return error instanceof Error && 'code' in error
}

function extractFieldsFromConstraint(constraintName: string, tableName: string): string[] | undefined {
  const parts = constraintName.replace(`${tableName}_`, '').split('_')

  if (parts[parts.length - 1] === 'key') {
    parts.pop()
  }

  return parts.length > 0 ? parts : undefined
}

function extractReferencedTable(constraintName: string): string | undefined {
  const fkeyMatch = constraintName.match(/_(.+)_fkey$/)

  return fkeyMatch?.[1]
}

export function mapDatabaseError(error: unknown, tableName: string): Error {
  if (!isPostgresError(error)) {
    return error as Error
  }

  const { code, constraint, column } = error

  switch (code) {
  case '23505': {
    const fields = constraint ? extractFieldsFromConstraint(constraint, tableName) : undefined

    return new UniqueConstraintViolationError(
      tableName,
      constraint || 'unknown',
      fields,
    )
  }

  case '23503': {
    const referencedTable = constraint ? extractReferencedTable(constraint) : undefined

    return new ForeignKeyConstraintViolationError(
      tableName,
      constraint || 'unknown',
      referencedTable,
    )
  }

  case '23502':
    return new NotNullConstraintViolationError(
      tableName,
      column,
    )

  default:
    return error
  }
}
