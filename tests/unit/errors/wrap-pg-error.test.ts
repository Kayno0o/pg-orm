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

function pgError(code: string, opts: Record<string, string> = {}): Error & Record<string, string> {
  const err = new Error(opts.message ?? `PG error ${code}`) as Error & Record<string, string>

  err.code = code

  for (const [k, v] of Object.entries(opts)) {
    if (k !== 'message')
      (err as any)[k] = v
  }

  return err
}

describe('wrapPgError', () => {
  it('maps 23505 to UniqueError', () => {
    const err = wrapPgError(pgError('23505', { constraint_name: 'uq_email', table_name: 'users', column_name: 'email' }), 'INSERT', [])

    expect(err).toBeInstanceOf(UniqueError)
    expect((err as UniqueError).constraint).toBe('uq_email')
    expect((err as UniqueError).column).toBe('email')
  })

  it('maps 23503 to ForeignKeyError', () => {
    const err = wrapPgError(pgError('23503', { constraint_name: 'fk_author', table_name: 'posts', detail: 'Key (authorId) is not present in table "users".' }), 'INSERT', [])

    expect(err).toBeInstanceOf(ForeignKeyError)
    expect((err as ForeignKeyError).referencedTable).toBe('users')
  })

  it('maps 23502 to NotNullError', () => {
    const err = wrapPgError(pgError('23502', { table_name: 'users', column_name: 'name' }), 'INSERT', [])

    expect(err).toBeInstanceOf(NotNullError)
    expect((err as NotNullError).column).toBe('name')
  })

  it('maps 23514 to CheckError', () => {
    const err = wrapPgError(pgError('23514', { constraint_name: 'chk_age', table_name: 'users' }), 'INSERT', [])

    expect(err).toBeInstanceOf(CheckError)
  })

  it('maps 08xxx to ConnectionError', () => {
    const err = wrapPgError(pgError('08003'), 'SELECT', [])

    expect(err).toBeInstanceOf(ConnectionError)
  })

  it('maps 57P01 (admin shutdown) to ConnectionError', () => {
    const err = wrapPgError(pgError('57P01'), 'SELECT', [])

    expect(err).toBeInstanceOf(ConnectionError)
  })

  it('maps 57014 to TimeoutError', () => {
    const err = wrapPgError(pgError('57014'), 'SELECT', [])

    expect(err).toBeInstanceOf(TimeoutError)
  })

  it('maps unknown codes to QueryError', () => {
    const err = wrapPgError(pgError('42601'), 'SELECT', [])

    expect(err).toBeInstanceOf(QueryError)
  })

  it('wraps non-Error values to OrmError', () => {
    const err = wrapPgError('string error', 'SELECT', [])

    expect(err).toBeInstanceOf(OrmError)
  })

  it('uses fallback field names (constraint/table/column)', () => {
    const err = wrapPgError(pgError('23505', { constraint: 'uq_email', table: 'users', column: 'email' }), 'INSERT', [])

    expect(err).toBeInstanceOf(UniqueError)
    expect((err as UniqueError).constraint).toBe('uq_email')
  })
})
