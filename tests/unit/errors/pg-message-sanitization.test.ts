import { afterEach, describe, expect, it } from 'bun:test'
import { sanitizePgErrorMessage, UniqueError, wrapPgError } from '../../../src/errors/index'

afterEach(() => {
  delete process.env.REDACT_QUERY_LOGS
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
