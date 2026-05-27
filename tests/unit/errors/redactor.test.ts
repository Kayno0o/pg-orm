import { afterEach, describe, expect, it } from 'bun:test'
import { QueryError, setParamRedactor } from '../../../src/errors/index'

afterEach(() => {
  // Tests are global-state — always reset the redactor and env.
  setParamRedactor(undefined)
  delete process.env.REDACT_QUERY_LOGS
})

describe('paramRedactor', () => {
  it('no redactor → params default-scrubbed to "[REDACTED]" (safe default)', () => {
    const err = new QueryError('boom', 'SELECT $1', ['secret'])

    expect(err.params).toEqual(['[REDACTED]'])
  })

  it('no redactor + REDACT_QUERY_LOGS=0 → params preserved verbatim (debug opt-out)', () => {
    process.env.REDACT_QUERY_LOGS = '0'

    const err = new QueryError('boom', 'SELECT $1', ['secret'])

    expect(err.params).toEqual(['secret'])
  })

  it('identity redactor → params preserved verbatim (explicit opt-out)', () => {
    setParamRedactor(p => p)

    const err = new QueryError('boom', 'SELECT $1', ['secret'])

    expect(err.params).toEqual(['secret'])
  })

  it('redactor return value is used', () => {
    setParamRedactor(() => ['[redacted]'])

    const err = new QueryError('boom', 'SELECT $1', ['secret'])

    expect(err.params).toEqual(['[redacted]'])
  })

  it('redactor receives the original param array', () => {
    let captured: unknown[] = []

    setParamRedactor((params) => {
      captured = params

      return params.map(() => '*')
    })

    void new QueryError('boom', 'SELECT $1, $2', ['alice', 'pw123'])

    expect(captured).toEqual(['alice', 'pw123'])
  })

  it('a throwing redactor surfaces — does NOT mask programming bugs as []', () => {
    const bug = new Error('redactor crashed: cannot read property of undefined')

    setParamRedactor(() => {
      throw bug
    })

    expect(() => new QueryError('boom', 'SELECT $1', ['secret'])).toThrow(bug)
  })

  it('setParamRedactor(undefined) clears the redactor → falls back to safe default', () => {
    setParamRedactor(() => ['x'])
    setParamRedactor(undefined)

    const err = new QueryError('boom', 'SELECT $1', ['raw'])

    expect(err.params).toEqual(['[REDACTED]'])
  })
})
