import { describe, expect, it } from 'bun:test'
import { serializePgArray } from '../../../src/sql/executor'

describe('serializePgArray', () => {
  it('serializes string arrays', () => {
    expect(serializePgArray(['a', 'b', 'c'])).toBe('{"a","b","c"}')
  })

  it('serializes number arrays', () => {
    expect(serializePgArray([1, 2, 3])).toBe('{1,2,3}')
  })

  it('serializes empty array', () => {
    expect(serializePgArray([])).toBe('{}')
  })

  it('serializes single-element array', () => {
    expect(serializePgArray(['hello'])).toBe('{"hello"}')
  })

  it('handles strings with spaces', () => {
    expect(serializePgArray(['hello world', 'foo bar'])).toBe('{"hello world","foo bar"}')
  })

  it('handles strings with commas', () => {
    expect(serializePgArray(['a,b', 'c,d'])).toBe('{"a,b","c,d"}')
  })

  it('escapes double quotes in strings', () => {
    expect(serializePgArray(['say "hi"'])).toBe('{"say \\"hi\\""}')
  })

  it('escapes backslashes in strings', () => {
    expect(serializePgArray(['C:\\path'])).toBe('{"C:\\\\path"}')
  })

  it('serializes null elements as NULL', () => {
    expect(serializePgArray([null, 'a', null])).toBe('{NULL,"a",NULL}')
  })

  it('serializes undefined elements as NULL', () => {
    expect(serializePgArray([undefined, 1])).toBe('{NULL,1}')
  })

  it('serializes boolean elements', () => {
    expect(serializePgArray([true, false])).toBe('{true,false}')
  })

  it('serializes nested arrays', () => {
    expect(serializePgArray([[1, 2], [3, 4]])).toBe('{{1,2},{3,4}}')
  })

  it('serializes mixed-type elements (numbers and strings)', () => {
    expect(serializePgArray(['Seb', 'Sebouille', 'Sebobar'])).toBe('{"Seb","Sebouille","Sebobar"}')
  })
})
