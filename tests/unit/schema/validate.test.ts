import { describe, expect, it } from 'bun:test'
import { sanitizeMigrationName, validateIdentifier, validateTsLanguage } from '../../../src/schema/validate'

describe('validateIdentifier', () => {
  it('accepts valid identifiers', () => {
    expect(() => validateIdentifier('users', 'table')).not.toThrow()
    expect(() => validateIdentifier('_private', 'column')).not.toThrow()
    expect(() => validateIdentifier('col_1', 'column')).not.toThrow()
    expect(() => validateIdentifier('A', 'column')).not.toThrow()
  })

  it('rejects identifiers starting with a digit', () => {
    expect(() => validateIdentifier('1user', 'table')).toThrow(/Invalid table name/)
  })

  it('rejects identifiers with special characters', () => {
    expect(() => validateIdentifier('user-name', 'column')).toThrow(/Invalid column name/)
    expect(() => validateIdentifier('user name', 'table')).toThrow(/Invalid table name/)
    expect(() => validateIdentifier('user.name', 'column')).toThrow()
  })

  it('rejects empty strings', () => {
    expect(() => validateIdentifier('', 'table')).toThrow()
  })

  it('rejects SQL injection attempts', () => {
    expect(() => validateIdentifier('users; DROP TABLE', 'table')).toThrow()
    expect(() => validateIdentifier('" OR 1=1 --', 'column')).toThrow()
  })

  it('includes context in error message', () => {
    expect(() => validateIdentifier('bad-name', 'column')).toThrow(/column/)
    expect(() => validateIdentifier('bad-name', 'table')).toThrow(/table/)
  })
})

describe('validateTsLanguage', () => {
  it('accepts valid languages', () => {
    expect(() => validateTsLanguage('english')).not.toThrow()
    expect(() => validateTsLanguage('simple')).not.toThrow()
    expect(() => validateTsLanguage('french')).not.toThrow()
    expect(() => validateTsLanguage('german')).not.toThrow()
  })

  it('rejects unknown languages', () => {
    expect(() => validateTsLanguage('klingon')).toThrow(/Invalid text search language/)
    expect(() => validateTsLanguage('')).toThrow()
  })

  it('rejects injection attempts in language', () => {
    expect(() => validateTsLanguage('english\'; DROP TABLE')).toThrow()
  })
})

describe('sanitizeMigrationName', () => {
  it('passes through valid names', () => {
    expect(sanitizeMigrationName('2024-01-01_migration')).toBe('2024-01-01_migration')
  })

  it('replaces special characters with underscore', () => {
    expect(sanitizeMigrationName('../etc/passwd')).toBe('___etc_passwd')
  })

  it('handles spaces and dots', () => {
    expect(sanitizeMigrationName('my migration.sql')).toBe('my_migration_sql')
  })
})
