import { afterEach, describe, expect, it } from 'bun:test'
import { sanitizePgErrorMessage, UniqueError, ValidationError, withParamRedactor, wrapPgError } from '../../../src/errors/index'

afterEach(() => {
  delete process.env.REDACT_QUERY_LOGS
  delete process.env.NODE_ENV
})

describe('sanitizePgErrorMessage', () => {
  it('replaces the value half of "Key (col)=(value)" with [REDACTED]', () => {
    const out = sanitizePgErrorMessage(
      'duplicate key value violates unique constraint "uq_email" Key (email)=(alice@example.com) already exists.',
    )

    expect(out).toContain('Key (email)=([REDACTED])')
    expect(out).not.toContain('alice@example.com')
  })

  it('handles composite-key "Key (a, b)=(v1, v2)" forms', () => {
    const out = sanitizePgErrorMessage('Key (a, b)=(1, 2) is not present in table "y".')

    expect(out).toContain('Key (a, b)=([REDACTED])')
    expect(out).not.toMatch(/Key \(a, b\)=\(1, 2\)/)
  })

  it('strips entire Detail: line content', () => {
    const out = sanitizePgErrorMessage('Constraint X failed.\nDetail: Some PII here.')

    expect(out).toContain('Detail: [redacted]')
    expect(out).not.toContain('PII here')
  })

  it('redacts a value holding a closing parenthesis to its end', () => {
    const out = sanitizePgErrorMessage('Key (email)=(a)b@x.com) already exists.')

    expect(out).toBe('Key (email)=([REDACTED])')
  })

  it('redacts the value of an expression key and both keys of an exclusion conflict', () => {
    expect(sanitizePgErrorMessage('Key (lower(email::text))=(bob@x.com) already exists.')).toBe('Key (lower(email::text))=([REDACTED])')
    expect(sanitizePgErrorMessage('Key (room)=(12) conflicts with existing key (room)=(12).')).toBe('Key (room)=([REDACTED])')
  })

  it('redacts the input Postgres quotes back in a data exception', () => {
    expect(sanitizePgErrorMessage('invalid input syntax for type uuid: "secret-val"')).toBe('invalid input syntax for type uuid: "[REDACTED]"')
    expect(sanitizePgErrorMessage('invalid input value for enum mood: "se"cret"')).toBe('invalid input value for enum mood: "[REDACTED]"')
    expect(sanitizePgErrorMessage('value "99999999999" is out of range for type integer')).toBe('value "[REDACTED]" is out of range for type integer')
    expect(sanitizePgErrorMessage('invalid byte sequence for encoding "UTF8": 0x00')).toBe('invalid byte sequence for encoding "UTF8": [REDACTED]')
    expect(sanitizePgErrorMessage('time zone "Secret/Zone" not recognized')).toBe('time zone "[REDACTED]" not recognized')
    expect(sanitizePgErrorMessage('syntax error at or near "hunter2"')).toBe('syntax error at or near "[REDACTED]"')
  })

  it('REDACT_QUERY_LOGS=0 opts out of sanitization', () => {
    process.env.REDACT_QUERY_LOGS = '0'

    const raw = 'Key (email)=(alice@example.com) already exists.'

    expect(sanitizePgErrorMessage(raw)).toBe(raw)
  })

  it('passes through messages with no sensitive markers', () => {
    const raw = 'unique_violation in users'

    expect(sanitizePgErrorMessage(raw)).toBe(raw)
  })
})

describe('wrapPgError integration — sensitive values do not leak into err.message', () => {
  it('UniqueError message strips the offending value', () => {
    const raw = Object.assign(
      new Error('duplicate key value violates unique constraint "uq_email" Key (email)=(secret@example.com) already exists.'),
      { errno: '23505', constraint_name: 'uq_email', table_name: 'users', column_name: 'email' },
    )

    const err = wrapPgError(raw, 'INSERT INTO users ...', ['secret@example.com'])

    expect(err).toBeInstanceOf(UniqueError)
    expect(err.message).not.toContain('secret@example.com')
    expect(err.message).toContain('Key (email)=([REDACTED])')
    // Structured info still available
    expect((err as UniqueError).constraint).toBe('uq_email')
    expect((err as UniqueError).column).toBe('email')
    // Raw error is preserved via .cause for explicit debugging
    expect((err.cause as Error).message).toContain('secret@example.com')
  })

  it('Detail: lines are stripped in default mode (not just production)', () => {
    delete process.env.NODE_ENV

    const raw = Object.assign(
      new Error('duplicate key\nDetail: Key (email)=(secret@example.com) already exists.'),
      { errno: '23505', constraint_name: 'uq_email', table_name: 'users' },
    )

    const err = wrapPgError(raw, 'INSERT', ['secret@example.com'])

    expect(err.message).not.toContain('secret@example.com')
    expect(err.message).toContain('Detail: [redacted]')
  })
})

describe('production errors hold no row value, cause chain included', () => {
  function driverError(message: string, fields: Record<string, unknown>): Error {
    return Object.assign(new Error(message), fields)
  }

  it('replaces the raw driver error on cause with a scrubbed copy', () => {
    process.env.NODE_ENV = 'production'

    const raw = driverError('duplicate key value violates unique constraint "uq_email"', {
      errno: '23505',
      code: 'ERR_POSTGRES_SERVER_ERROR',
      detail: 'Key (email)=(secret@example.com) already exists.',
      constraint: 'uq_email',
      table: 'users',
      where: 'secret@example.com',
    })
    const err = wrapPgError(raw, 'INSERT', ['secret@example.com'])
    const cause = err.cause as Error & Record<string, unknown>

    expect(cause).not.toBe(raw)
    expect(cause.message).toBe('duplicate key value violates unique constraint "uq_email"')
    expect(cause.detail).toBeUndefined()
    expect(cause.where).toBeUndefined()
    expect(cause).toMatchObject({ errno: '23505', code: 'ERR_POSTGRES_SERVER_ERROR', constraint: 'uq_email', table: 'users' })
    expect(JSON.stringify({ ...err, cause: { ...cause, message: cause.message } })).not.toContain('secret')
  })

  it('scrubs a data exception\'s message on both the error and its cause', () => {
    process.env.NODE_ENV = 'production'

    const err = wrapPgError(driverError('invalid input syntax for type uuid: "secret-val"', { errno: '22P02' }), 'SELECT', ['secret-val'])

    expect(err.message).not.toContain('secret')
    expect((err.cause as Error).message).not.toContain('secret')
  })

  it('keeps the raw driver error on cause outside production', () => {
    const raw = driverError('duplicate key', { errno: '23505', detail: 'Key (email)=(secret@example.com) already exists.' })

    expect(wrapPgError(raw, 'INSERT', []).cause).toBe(raw)
  })

  it('REDACT_QUERY_LOGS=0 keeps query, params and cause raw in production, past a redactor', () => {
    process.env.NODE_ENV = 'production'
    process.env.REDACT_QUERY_LOGS = '0'
    const raw = driverError('duplicate key', { errno: '23505' })
    const err = withParamRedactor(params => params.map(() => '***'), () => wrapPgError(raw, 'INSERT INTO "users"', ['secret'])) as UniqueError

    expect(err.query).toBe('INSERT INTO "users"')
    expect(err.params).toEqual(['secret'])
    expect(err.cause).toBe(raw)
  })

  it('redacts ValidationError.value in production', () => {
    process.env.NODE_ENV = 'production'

    expect(new ValidationError('bad row', 'updateManyById', { value: { email: 'secret' } }).value).toBe('[REDACTED]')
  })
})
