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
import { retryableFor } from '../../../src/sql/retry'
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

  it('maps a server starting or crashing, and bun:sql\'s connection timeouts, to a ConnectionError a read retries', () => {
    const errors = [
      Object.assign(new Error('crash shutdown'), { errno: '57P02' }),
      Object.assign(new Error('the database system is starting up'), { errno: '57P03' }),
      ...['ERR_POSTGRES_CONNECTION_TIMEOUT', 'ERR_POSTGRES_IDLE_TIMEOUT', 'ERR_POSTGRES_LIFETIME_TIMEOUT'].map(code => Object.assign(new Error(code), { code })),
    ]

    for (const raw of errors) {
      const err = wrapPgError(raw, 'SELECT * FROM "users"', [])

      expect(err).toBeInstanceOf(ConnectionError)
      expect(err).toMatchObject({ table: 'users' })
      expect(retryableFor('SELECT * FROM "users"', false)(err)).toBe(true)
    }
  })

  it('reads a column only from a string field: bun:sql\'s numeric `column` is a source position', () => {
    const err = wrapPgError(makePgError('23505', { column: 27 as unknown as string }), 'INSERT', [])

    expect((err as UniqueError).column).toBe('email')
  })
})
