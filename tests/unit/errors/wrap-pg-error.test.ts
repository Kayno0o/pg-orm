import { describe, expect, it } from 'bun:test'
import {
  CheckError,
  ConnectionError,
  ForeignKeyError,
  NotNullError,
  OrmError,
  QueryError,
  TimeoutError,
  UniqueError,
  wrapPgError,
} from '../../../src/errors/index'
import { makePgError } from '../../helpers/pg-error-shapes'

describe('wrapPgError', () => {
  it('maps 23505 to UniqueError', () => {
    const err = wrapPgError(makePgError('23505', { constraint_name: 'uq_email', table_name: 'users', column_name: 'email' }), 'INSERT', [])

    expect(err).toBeInstanceOf(UniqueError)
    expect((err as UniqueError).constraint).toBe('uq_email')
    expect((err as UniqueError).column).toBe('email')
  })

  it('maps 23503 to ForeignKeyError', () => {
    const err = wrapPgError(makePgError('23503', { constraint_name: 'fk_author', table_name: 'posts', detail: 'Key (authorId) is not present in table "users".' }), 'INSERT', [])

    expect(err).toBeInstanceOf(ForeignKeyError)
    expect((err as ForeignKeyError).referencedTable).toBe('users')
  })

  it('maps 23502 to NotNullError', () => {
    const err = wrapPgError(makePgError('23502', { table_name: 'users', column_name: 'name' }), 'INSERT', [])

    expect(err).toBeInstanceOf(NotNullError)
    expect((err as NotNullError).column).toBe('name')
  })

  it('maps 23514 to CheckError', () => {
    const err = wrapPgError(makePgError('23514', { constraint_name: 'chk_age', table_name: 'users' }), 'INSERT', [])

    expect(err).toBeInstanceOf(CheckError)
  })

  it('maps 08xxx to ConnectionError', () => {
    const err = wrapPgError(makePgError('08006'), 'SELECT', [])

    expect(err).toBeInstanceOf(ConnectionError)
  })

  it('maps 57P01 (admin shutdown) to ConnectionError', () => {
    const fake = new Error('admin shutdown') as Error & { errno: string }

    fake.errno = '57P01'
    const err = wrapPgError(fake, 'SELECT', [])

    expect(err).toBeInstanceOf(ConnectionError)
  })

  it('maps 57014 to TimeoutError', () => {
    const err = wrapPgError(makePgError('57014'), 'SELECT', [])

    expect(err).toBeInstanceOf(TimeoutError)
  })

  it('maps unknown codes to QueryError', () => {
    const fake = new Error('syntax error') as Error & { errno: string }

    fake.errno = '42601'
    const err = wrapPgError(fake, 'SELECT', [])

    expect(err).toBeInstanceOf(QueryError)
  })

  it('wraps non-Error values to OrmError', () => {
    const err = wrapPgError('string error', 'SELECT', [])

    expect(err).toBeInstanceOf(OrmError)
  })

  it('uses fallback field names (constraint/table/column)', () => {
    // Some drivers emit short-form fields; verify wrapPgError accepts them.
    const fake = new Error('dup') as Error & Record<string, string>

    fake.errno = '23505'
    fake.constraint = 'uq_email'
    fake.table = 'users'
    fake.column = 'email'

    const err = wrapPgError(fake, 'INSERT', [])

    expect(err).toBeInstanceOf(UniqueError)
    expect((err as UniqueError).constraint).toBe('uq_email')
  })
})
