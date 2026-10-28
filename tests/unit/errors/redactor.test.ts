import { afterEach, describe, expect, it } from 'bun:test'
import { QueryError, withParamRedactor } from '../../../src/errors/index'

afterEach(() => {
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
    const err = withParamRedactor(p => p, () => new QueryError('boom', 'SELECT $1', ['secret']))

    expect(err.params).toEqual(['secret'])
  })

  it('redactor return value is used', () => {
    const err = withParamRedactor(() => ['[redacted]'], () => new QueryError('boom', 'SELECT $1', ['secret']))

    expect(err.params).toEqual(['[redacted]'])
  })

  it('redactor receives the original param array', () => {
    let captured: unknown[] = []

    withParamRedactor((params) => {
      captured = params

      return params.map(() => '*')
    }, () => new QueryError('boom', 'SELECT $1, $2', ['alice', 'pw123']))

    expect(captured).toEqual(['alice', 'pw123'])
  })

  it('a throwing redactor surfaces — does NOT mask programming bugs as []', () => {
    const bug = new Error('redactor crashed: cannot read property of undefined')
    const redactor = (): unknown[] => {
      throw bug
    }

    expect(() => withParamRedactor(redactor, () => new QueryError('boom', 'SELECT $1', ['secret']))).toThrow(bug)
  })

  it('applies only to errors raised inside its scope, async work included', async () => {
    const inside = await withParamRedactor(() => ['x'], async () => {
      await Bun.sleep(0)

      return new QueryError('boom', 'SELECT $1', ['raw'])
    })

    expect(inside.params).toEqual(['x'])
    expect(new QueryError('boom', 'SELECT $1', ['raw']).params).toEqual(['[REDACTED]'])
  })
})
