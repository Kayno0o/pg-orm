import { describe, expect, it } from 'bun:test'
import {
  CheckError,
  ConnectionError,
  ConstraintError,
  DestructiveOpError,
  ForeignKeyError,
  MigrationError,
  NotNullError,
  OrmError,
  QueryError,
  StaleRecordError,
  TimeoutError,
  UniqueError,
} from '../../../src/errors/index'

describe('Error hierarchy', () => {
  it('OrmError is an Error', () => {
    const err = new OrmError('test')

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(OrmError)
    expect(err.message).toBe('test')
    expect(err.name).toBe('OrmError')
  })

  it('OrmError preserves cause', () => {
    const cause = new Error('root')
    const err = new OrmError('wrapper', cause)

    expect(err.cause).toBe(cause)
  })

  it('QueryError extends OrmError', () => {
    const err = new QueryError('bad query', 'SELECT 1', [])

    expect(err).toBeInstanceOf(OrmError)
    expect(err).toBeInstanceOf(QueryError)
    expect(err.name).toBe('QueryError')
    expect(err.query).toBe('SELECT 1')
    expect(err.params).toEqual([])
  })

  it('ConnectionError extends OrmError', () => {
    const err = new ConnectionError('connection lost')

    expect(err).toBeInstanceOf(OrmError)
    expect(err.name).toBe('ConnectionError')
  })

  it('TimeoutError extends OrmError', () => {
    const err = new TimeoutError('timed out')

    expect(err).toBeInstanceOf(OrmError)
    expect(err.name).toBe('TimeoutError')
  })

  it('ConstraintError extends QueryError', () => {
    const err = new ConstraintError('constraint failed', 'INSERT ...', [], { constraint: 'uq_email', table: 'users' })

    expect(err).toBeInstanceOf(QueryError)
    expect(err.constraint).toBe('uq_email')
    expect(err.table).toBe('users')
  })

  it('UniqueError extends ConstraintError', () => {
    const err = new UniqueError('unique violation', 'INSERT ...', [], { constraint: 'uq_email', table: 'users', column: 'email' })

    expect(err).toBeInstanceOf(ConstraintError)
    expect(err.name).toBe('UniqueError')
    expect(err.column).toBe('email')
  })

  it('ForeignKeyError extends ConstraintError', () => {
    const err = new ForeignKeyError('fk violation', 'INSERT ...', [], { constraint: 'fk_author', table: 'posts', referencedTable: 'users' })

    expect(err).toBeInstanceOf(ConstraintError)
    expect(err.name).toBe('ForeignKeyError')
    expect(err.referencedTable).toBe('users')
  })

  it('NotNullError extends ConstraintError', () => {
    const err = new NotNullError('not null violation', 'INSERT ...', [], { constraint: '', table: 'users', column: 'name' })

    expect(err).toBeInstanceOf(ConstraintError)
    expect(err.name).toBe('NotNullError')
    expect(err.column).toBe('name')
  })

  it('CheckError extends ConstraintError', () => {
    const err = new CheckError('check violation', 'INSERT ...', [], { constraint: 'chk_age', table: 'users' })

    expect(err).toBeInstanceOf(ConstraintError)
    expect(err.name).toBe('CheckError')
  })

  it('MigrationError extends OrmError', () => {
    const err = new MigrationError('migration failed', 'apply')

    expect(err).toBeInstanceOf(OrmError)
    expect(err.name).toBe('MigrationError')
    expect(err.phase).toBe('apply')
  })

  it('DestructiveOpError extends MigrationError', () => {
    const err = new DestructiveOpError('destructive', 'diff', ['drop table users'])

    expect(err).toBeInstanceOf(MigrationError)
    expect(err.name).toBe('DestructiveOpError')
    expect(err.ops).toEqual(['drop table users'])
  })

  it('StaleRecordError extends OrmError', () => {
    const err = new StaleRecordError('users', 3)

    expect(err).toBeInstanceOf(OrmError)
    expect(err.name).toBe('StaleRecordError')
    expect(err.table).toBe('users')
    expect(err.version).toBe(3)
    expect(err.message).toContain('version 3')
    expect(err.message).toContain('users')
  })
})

describe('Error redaction', () => {
  it('QueryError stores query when REDACT is not set', () => {
    const err = new QueryError('bad', 'SELECT 1', [42])

    expect(err.query).toBe('SELECT 1')
    expect(err.params).toEqual([42])
  })
})
