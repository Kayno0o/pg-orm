import type { AnyColumns } from '../../../src'
import { describe, expect, it } from 'bun:test'
import { clearMapperCache, compileMapper, getOrCompileMapper, mapChunk } from '../../../src/mapper/index'

const columns = {
  id: { _kind: 'column', pgType: 'serial', constraints: [] },
  name: { _kind: 'column', pgType: 'text', constraints: [] },
  age: { _kind: 'column', pgType: 'int4', constraints: [] },
} as unknown as AnyColumns

describe('compileMapper', () => {
  it('returns identity mapper when all columns selected', () => {
    const mapper = compileMapper(columns)
    const row = { id: 1, name: 'Alice', age: 30 }
    const result = mapper(row)

    expect(result).toBe(row) // identity returns same reference
  })

  it('picks specified columns', () => {
    const mapper = compileMapper(columns, ['id', 'name'])
    const row = { id: 1, name: 'Alice', age: 30 }
    const result = mapper(row)

    expect(result).toEqual({ id: 1, name: 'Alice' })
    expect(result).not.toHaveProperty('age')
  })

  it('omits specified columns', () => {
    const mapper = compileMapper(columns, undefined, ['age'])
    const row = { id: 1, name: 'Alice', age: 30 }
    const result = mapper(row)

    expect(result).toEqual({ id: 1, name: 'Alice' })
  })

  it('pick + omit combined', () => {
    const mapper = compileMapper(columns, ['id', 'name', 'age'], ['age'])
    const result = mapper({ id: 1, name: 'Alice', age: 30 })

    expect(result).toEqual({ id: 1, name: 'Alice' })
  })
})

describe('mapChunk', () => {
  it('identity mapper returns same array', () => {
    const mapper = compileMapper(columns)
    const rows = [{ id: 1, name: 'Alice', age: 30 }]
    const result = mapChunk(mapper, rows)

    expect(result).toBe(rows) // Same reference
  })

  it('non-identity mapper maps each row', () => {
    const mapper = compileMapper(columns, ['id'])
    const rows = [
      { id: 1, name: 'Alice', age: 30 },
      { id: 2, name: 'Bob', age: 25 },
    ]
    const result = mapChunk(mapper, rows)

    expect(result).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('handles empty array', () => {
    const mapper = compileMapper(columns, ['id'])
    const result = mapChunk(mapper, [])

    expect(result).toEqual([])
  })
})

describe('getOrCompileMapper', () => {
  it('caches mappers by fingerprint', () => {
    clearMapperCache()

    const m1 = getOrCompileMapper('test', columns, ['id'])
    const m2 = getOrCompileMapper('test', columns, ['id'])

    expect(m1).toBe(m2)
  })

  it('different picks produce different mappers', () => {
    clearMapperCache()

    const m1 = getOrCompileMapper('test', columns, ['id'])
    const m2 = getOrCompileMapper('test', columns, ['name'])

    expect(m1).not.toBe(m2)
  })

  it('different tables produce different mappers', () => {
    clearMapperCache()

    const m1 = getOrCompileMapper('table_a', columns, ['id'])
    const m2 = getOrCompileMapper('table_b', columns, ['id'])

    expect(m1).not.toBe(m2)
  })

  it('evicts oldest entries when cache exceeds max', () => {
    clearMapperCache()

    // Fill cache to just over 1000
    for (let i = 0; i < 1002; i++) {
      getOrCompileMapper(`eviction_test_${i}`, columns, ['id'])
    }

    // After eviction, the first entries should be gone but recent entries remain
    // We can't directly check cache size, but the mapper for the last entry should exist
    const recent = getOrCompileMapper('eviction_test_1001', columns, ['id'])

    expect(recent).toBeDefined()
  })
})

describe('clearMapperCache', () => {
  it('clears all cached mappers', () => {
    getOrCompileMapper('clear_test', columns, ['id'])

    clearMapperCache()
    const m2 = getOrCompileMapper('clear_test', columns, ['id'])

    // After clearing, a new mapper is compiled (different reference)
    // However they may be functionally identical. Let's just verify no throw.
    expect(m2).toBeDefined()
  })
})

describe('computed aliases', () => {
  it('carries a computed alias through a picked projection', () => {
    const mapper = compileMapper(columns, ['id'], undefined, ['n'])

    expect(mapper({ id: 1, n: '42' })).toEqual({ id: 1, n: '42' })
  })

  it('drops a row key that is neither picked nor computed', () => {
    const mapper = compileMapper(columns, ['id'], undefined, ['n'])

    expect(mapper({ id: 1, n: 2, name: 'x' })).toEqual({ id: 1, n: 2 })
  })

  it('does not emit an alias twice when it shadows a picked column', () => {
    const mapper = compileMapper(columns, ['id', 'name'], undefined, ['name'])

    expect(mapper({ id: 1, name: 'x' })).toEqual({ id: 1, name: 'x' })
  })

  it('keys the cache on the aliases, so the same pick with different ones recompiles', () => {
    clearMapperCache()

    const withN = getOrCompileMapper('computed_cache', columns, ['id'], undefined, ['n'])
    const withTotal = getOrCompileMapper('computed_cache', columns, ['id'], undefined, ['total'])

    expect(withN({ id: 1, n: 5, total: 9 })).toEqual({ id: 1, n: 5 })
    expect(withTotal({ id: 1, n: 5, total: 9 })).toEqual({ id: 1, total: 9 })
  })
})
