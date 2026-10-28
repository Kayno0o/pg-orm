import { describe, expect, it } from 'bun:test'
import { ValidationError } from '../../../src/errors/index'
import { inlineParams } from '../../../src/sql/copy'
import { jsonParam } from '../../../src/sql/json-param'

describe('inlineParams', () => {
  it('writes each value as an E string, doubling quotes and backslashes', () => {
    expect(inlineParams('"a" = $1', ['it\'s a \\\' trap'])).toBe('"a" = E\'it\'\'s a \\\\\'\' trap\'')
  })

  it('replaces $10 as one placeholder, not $1 followed by 0', () => {
    const params = Array.from({ length: 10 }, (_, i) => i + 1)

    expect(inlineParams('$1, $10', params)).toBe('E\'1\', E\'10\'')
  })

  it('writes each type in the text form Postgres reads it from', () => {
    const sql = inlineParams('$1 $2 $3 $4 $5 $6 $7 $8 $9', [null, undefined, true, 12n, new Date('2026-01-02T03:04:05.000Z'), new Uint8Array([1, 255]), ['a', 'b"c'], { k: 1n }, jsonParam('x')])

    expect(sql).toBe('NULL NULL E\'t\' E\'12\' E\'2026-01-02T03:04:05.000Z\' E\'\\\\x01ff\' E\'{"a","b\\\\"c"}\' E\'{"k":"1"}\' E\'"x"\'')
  })

  it('refuses a NUL character, which Postgres rejects in any text', () => {
    expect(() => inlineParams('$1', ['a\0b'])).toThrow(ValidationError)
  })
})
