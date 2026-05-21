import { afterEach, describe, expect, it } from 'bun:test'
import { QueryError, setParamRedactor } from '../../../src/errors/index'

afterEach(() => {
  // Tests are global-state — always reset the redactor.
  setParamRedactor(undefined)
})

describe('paramRedactor', () => {
  it('no redactor → params passed through unchanged', () => {
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

  it('setParamRedactor(undefined) clears the redactor', () => {
    setParamRedactor(() => ['x'])
    setParamRedactor(undefined)

    const err = new QueryError('boom', 'SELECT $1', ['raw'])

    expect(err.params).toEqual(['raw'])
  })
})
