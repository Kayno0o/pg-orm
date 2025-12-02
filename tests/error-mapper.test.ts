import { describe, expect, test } from 'bun:test'
import {
  ForeignKeyConstraintViolationError,
  NotNullConstraintViolationError,
  UniqueConstraintViolationError,
} from '../src/errors'
import { mapDatabaseError } from '../src/utils/error-mapper'

describe('Error Mapper', () => {
  describe('Unique Constraint Violations (23505)', () => {
    test('should map unique constraint error with constraint name', () => {
      const postgresError = new Error('duplicate key value violates unique constraint') as any

      postgresError.code = '23505'
      postgresError.constraint = 'users_email_key'
      postgresError.table = 'users'

      const mapped = mapDatabaseError(postgresError, 'users')

      expect(mapped).toBeInstanceOf(UniqueConstraintViolationError)
      expect((mapped as UniqueConstraintViolationError).entityName).toBe('users')
      expect((mapped as UniqueConstraintViolationError).constraintName).toBe('users_email_key')
      expect((mapped as UniqueConstraintViolationError).fields).toEqual(['email'])
    })

    test('should extract multiple fields from constraint name', () => {
      const postgresError = new Error('duplicate key') as any

      postgresError.code = '23505'
      postgresError.constraint = 'posts_user_id_slug_key'

      const mapped = mapDatabaseError(postgresError, 'posts')

      expect(mapped).toBeInstanceOf(UniqueConstraintViolationError)
      expect((mapped as UniqueConstraintViolationError).fields).toEqual(['user', 'id', 'slug'])
    })

    test('should handle constraint without table prefix', () => {
      const postgresError = new Error('duplicate key') as any

      postgresError.code = '23505'
      postgresError.constraint = 'email_key'

      const mapped = mapDatabaseError(postgresError, 'users')

      expect(mapped).toBeInstanceOf(UniqueConstraintViolationError)
      expect((mapped as UniqueConstraintViolationError).fields).toEqual(['email'])
    })
  })

  describe('Foreign Key Constraint Violations (23503)', () => {
    test('should map foreign key constraint error', () => {
      const postgresError = new Error('violates foreign key constraint') as any

      postgresError.code = '23503'
      postgresError.constraint = 'posts_user_id_fkey'
      postgresError.table = 'posts'

      const mapped = mapDatabaseError(postgresError, 'posts')

      expect(mapped).toBeInstanceOf(ForeignKeyConstraintViolationError)
      expect((mapped as ForeignKeyConstraintViolationError).entityName).toBe('posts')
      expect((mapped as ForeignKeyConstraintViolationError).constraintName).toBe('posts_user_id_fkey')
      expect((mapped as ForeignKeyConstraintViolationError).referencedTable).toBe('user_id')
    })

    test('should handle constraint without referenced table extraction', () => {
      const postgresError = new Error('violates foreign key constraint') as any

      postgresError.code = '23503'
      postgresError.constraint = 'custom_fk_constraint'

      const mapped = mapDatabaseError(postgresError, 'posts')

      expect(mapped).toBeInstanceOf(ForeignKeyConstraintViolationError)
      expect((mapped as ForeignKeyConstraintViolationError).referencedTable).toBeUndefined()
    })
  })

  describe('Not Null Constraint Violations (23502)', () => {
    test('should map not null constraint error with column name', () => {
      const postgresError = new Error('null value in column violates not-null constraint') as any

      postgresError.code = '23502'
      postgresError.column = 'email'
      postgresError.table = 'users'

      const mapped = mapDatabaseError(postgresError, 'users')

      expect(mapped).toBeInstanceOf(NotNullConstraintViolationError)
      expect((mapped as NotNullConstraintViolationError).entityName).toBe('users')
      expect((mapped as NotNullConstraintViolationError).columnName).toBe('email')
    })

    test('should map not null error when column is missing from constraint', () => {
      const postgresError = new Error('null value violates not-null constraint') as any

      postgresError.code = '23502'
      postgresError.column = undefined

      const mapped = mapDatabaseError(postgresError, 'users')

      expect(mapped).toBeInstanceOf(NotNullConstraintViolationError)
      expect((mapped as NotNullConstraintViolationError).entityName).toBe('users')
    })
  })

  describe('Non-Postgres Errors', () => {
    test('should return original error for non-postgres errors', () => {
      const regularError = new Error('Regular error')
      const mapped = mapDatabaseError(regularError, 'users')

      expect(mapped).toBe(regularError)
    })

    test('should return original error for unknown postgres error codes', () => {
      const postgresError = new Error('Some postgres error') as any

      postgresError.code = '99999'

      const mapped = mapDatabaseError(postgresError, 'users')

      expect(mapped).toBe(postgresError)
    })
  })
})
