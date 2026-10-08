import type { QueryEvent } from '../../../src/index'
import { afterEach, describe, expect, it } from 'bun:test'
import { setParamRedactor } from '../../../src/index'
import { composeQueryLogger, formatQuery } from '../../../src/sql/format-query'

function event(sql: string, params: unknown[] = [], durationMs = 1.2345): QueryEvent {
  return { sql, params, durationMs }
}

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV
  process.env.REDACT_QUERY_LOGS = ORIGINAL_ENV.REDACT_QUERY_LOGS
  setParamRedactor(undefined)
})

describe('formatQuery: placeholder inlining', () => {
  it('inlines params in order', () => {
    const line = formatQuery(event('SELECT * FROM "u" WHERE "a" = $1 AND "b" = $2', ['x', 3]), { duration: false })

    expect(line).toBe('SELECT * FROM "u" WHERE "a" = \'x\' AND "b" = 3')
  })

  it('handles multi-digit placeholders', () => {
    const params = Array.from({ length: 12 }, (_, i) => i + 1)
    const line = formatQuery(event('VALUES ($10, $11, $12, $1)', params), { duration: false })

    expect(line).toBe('VALUES (10, 11, 12, 1)')
  })

  it('leaves placeholders with no matching param untouched', () => {
    expect(formatQuery(event('SELECT $1, $2', ['a']), { duration: false })).toBe('SELECT \'a\', $2')
  })

  it('escapes single quotes in string params', () => {
    expect(formatQuery(event('SELECT $1', ['O\'Brien']), { duration: false })).toBe('SELECT \'O\'\'Brien\'')
  })

  it('renders each param kind as its SQL literal', () => {
    const line = formatQuery(
      event('SELECT $1, $2, $3, $4, $5, $6', [null, undefined, true, false, 10n, new Date('2026-07-21T00:00:00.000Z')]),
      { duration: false },
    )

    expect(line).toBe('SELECT NULL, NULL, TRUE, FALSE, 10, \'2026-07-21T00:00:00.000Z\'')
  })

  it('renders objects and arrays as JSON literals', () => {
    expect(formatQuery(event('SELECT $1, $2', [{ a: 1 }, [1, 2]]), { duration: false }))
      .toBe('SELECT \'{"a":1}\', \'[1,2]\'')
  })

  it('renders byte arrays as hex literals', () => {
    expect(formatQuery(event('SELECT $1', [new Uint8Array([0xDE, 0xAD])]), { duration: false }))
      .toBe('SELECT \'\\xdead\'')
  })

  it('truncates long params at maxParamLength, keeping the quoting balanced', () => {
    const line = formatQuery(event('SELECT $1', ['a'.repeat(50)]), { duration: false, maxParamLength: 10 })

    expect(line).toBe(`SELECT '${'a'.repeat(10)}...'`)
  })

  it('does not truncate when maxParamLength is 0', () => {
    const line = formatQuery(event('SELECT $1', ['a'.repeat(500)]), { duration: false, maxParamLength: 0 })

    expect(line).toHaveLength('SELECT '.length + 502)
  })
})

describe('formatQuery: duration and colors', () => {
  it('prefixes the duration by default', () => {
    expect(formatQuery(event('SELECT 1', [], 1.2345))).toBe('[1.234ms] SELECT 1')
  })

  it('omits the prefix when the duration is not finite', () => {
    expect(formatQuery(event('SELECT 1', [], Number.NaN))).toBe('SELECT 1')
  })

  it('wraps params in ANSI codes when colors are on', () => {
    expect(formatQuery(event('SELECT $1', [1]), { duration: false, colors: true }))
      .toBe('SELECT \x1B[33m1\x1B[0m')
  })
})

describe('formatQuery: redaction', () => {
  it('redacts everything in production', () => {
    process.env.NODE_ENV = 'production'

    expect(formatQuery(event('SELECT $1', ['secret']))).toBe('[1.234ms] [REDACTED]')
  })

  it('redacts everything when REDACT_QUERY_LOGS=1', () => {
    process.env.REDACT_QUERY_LOGS = '1'

    expect(formatQuery(event('SELECT $1', ['secret']), { duration: false })).toBe('[REDACTED]')
  })

  it('applies a registered param redactor before inlining', () => {
    setParamRedactor(params => params.map(() => '***'))

    expect(formatQuery(event('SELECT $1', ['secret']), { duration: false })).toBe('SELECT \'***\'')
  })

  it('renders raw values when REDACT_QUERY_LOGS=0, in production and past a redactor', () => {
    process.env.NODE_ENV = 'production'
    process.env.REDACT_QUERY_LOGS = '0'
    setParamRedactor(params => params.map(() => '***'))

    expect(formatQuery(event('SELECT $1', ['secret']), { duration: false })).toBe('SELECT \'secret\'')
  })
})

describe('composeQueryLogger', () => {
  it('returns onQuery untouched when debug is off', () => {
    const seen: QueryEvent[] = []
    const onQuery = (e: QueryEvent): number => seen.push(e)

    expect(composeQueryLogger(undefined, onQuery)).toBe(onQuery)
    expect(composeQueryLogger(false, onQuery)).toBe(onQuery)
    expect(composeQueryLogger(false, undefined)).toBeUndefined()
  })

  it('routes formatted lines to a function sink and still calls onQuery', () => {
    const lines: string[] = []
    const seen: QueryEvent[] = []
    const logger = composeQueryLogger(line => lines.push(line), e => seen.push(e))!

    logger(event('SELECT $1', ['x']))

    expect(lines).toEqual(['[1.234ms] SELECT \'x\''])
    expect(seen).toHaveLength(1)
  })

  it('never wires the sink when query logs are redacted', () => {
    process.env.NODE_ENV = 'production'

    const lines: string[] = []

    expect(composeQueryLogger(line => lines.push(line), undefined)).toBeUndefined()
    expect(lines).toEqual([])
  })
})
