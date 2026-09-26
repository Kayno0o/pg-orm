import type { AnyColumns } from '../../../src'
import { describe, expect, it } from 'bun:test'
import { clearMapperCache, compileMapper, getOrCompileMapper } from '../../../src/mapper/index'

function makeCols(spec: Record<string, string>): AnyColumns {
  const out: Record<string, unknown> = {}

  for (const [name, pgType] of Object.entries(spec)) {
    out[name] = { _kind: 'column', pgType, constraints: [] }
  }

  return out as AnyColumns
}

describe('mapper bigint coercion', () => {
  it('coerces int8 string values to BigInt', () => {
    const mapper = compileMapper(makeCols({ id: 'int8' }))
    const result = mapper({ id: '9007199254740993' })

    expect(typeof result.id).toBe('bigint')
    expect(result.id).toBe(9007199254740993n)
  })

  it('coerces bigserial string values to BigInt', () => {
    const mapper = compileMapper(makeCols({ id: 'bigserial' }))
    const result = mapper({ id: '42' })

    expect(typeof result.id).toBe('bigint')
    expect(result.id).toBe(42n)
  })

  it('preserves null int8 values', () => {
    const mapper = compileMapper(makeCols({ id: 'int8' }))
    const result = mapper({ id: null })

    expect(result.id).toBeNull()
  })

  it('preserves undefined int8 values as null/undefined (no coercion)', () => {
    const mapper = compileMapper(makeCols({ id: 'int8' }))
    const result = mapper({ id: undefined })

    expect(result.id).toBeUndefined()
  })

  it('passes through already-bigint values', () => {
    const mapper = compileMapper(makeCols({ id: 'int8' }))
    const result = mapper({ id: 123n })

    expect(result.id).toBe(123n)
  })

  it('handles a mix of bigint and non-bigint columns', () => {
    const mapper = compileMapper(makeCols({ id: 'int8', name: 'text', age: 'int4' }))
    const result = mapper({ id: '99', name: 'Alice', age: 30 })

    expect(result).toEqual({ id: 99n, name: 'Alice', age: 30 })
    expect(typeof result.id).toBe('bigint')
  })

  it('bigint columns force JIT path (not identity) even with no pick/omit', () => {
    const cols = makeCols({ id: 'int8' })
    const mapper = compileMapper(cols)
    const row = { id: '1' }
    const result = mapper(row)

    // identity would return same reference; JIT returns a fresh object
    expect(result).not.toBe(row)
  })

  it('respects pick when bigint columns are present', () => {
    const mapper = compileMapper(makeCols({ id: 'int8', name: 'text' }), ['id'])
    const result = mapper({ id: '7', name: 'ignored' })

    expect(result).toEqual({ id: 7n })
    expect(result).not.toHaveProperty('name')
  })

  it('respects omit when bigint columns are present', () => {
    const mapper = compileMapper(makeCols({ id: 'int8', name: 'text' }), undefined, ['name'])
    const result = mapper({ id: '7', name: 'gone' })

    expect(result).toEqual({ id: 7n })
    expect(result).not.toHaveProperty('name')
  })
})

describe('mapper json coercion', () => {
  it('parses jsonb string values into objects', () => {
    const mapper = compileMapper(makeCols({ id: 'int4', data: 'jsonb' }))
    const result = mapper({ id: 1, data: '{"name":"doc","tags":["a"]}' })

    expect(result.data).toEqual({ name: 'doc', tags: ['a'] })
  })

  it('parses json string values into objects', () => {
    const mapper = compileMapper(makeCols({ id: 'int4', data: 'json' }))
    const result = mapper({ id: 1, data: '{"ok":true}' })

    expect(result.data).toEqual({ ok: true })
  })

  it('parses jsonb array string values', () => {
    const mapper = compileMapper(makeCols({ id: 'int4', data: 'jsonb' }))
    const result = mapper({ id: 1, data: '[1,2,3]' })

    expect(result.data).toEqual([1, 2, 3])
  })

  it('preserves null jsonb values', () => {
    const mapper = compileMapper(makeCols({ id: 'int4', data: 'jsonb' }))
    const result = mapper({ id: 1, data: null })

    expect(result.data).toBeNull()
  })

  it('passes through already-parsed jsonb objects', () => {
    const mapper = compileMapper(makeCols({ id: 'int4', data: 'jsonb' }))
    const result = mapper({ id: 1, data: { parsed: true } })

    expect(result.data).toEqual({ parsed: true })
  })

  it('json columns force JIT path (not identity) even with no pick/omit', () => {
    const cols = makeCols({ id: 'int4', data: 'jsonb' })
    const mapper = compileMapper(cols)
    const row = { id: 1, data: '{"a":1}' }
    const result = mapper(row)

    // identity would return same reference; JIT returns a fresh object
    expect(result).not.toBe(row)
  })

  it('respects pick when json columns are present', () => {
    const mapper = compileMapper(makeCols({ id: 'int4', name: 'text', data: 'jsonb' }), ['id', 'data'])
    const result = mapper({ id: 1, name: 'ignored', data: '{"a":1}' })

    expect(result).toEqual({ id: 1, data: { a: 1 } })
    expect(result).not.toHaveProperty('name')
  })

  it('respects omit when json columns are present', () => {
    const mapper = compileMapper(makeCols({ id: 'int4', name: 'text', data: 'jsonb' }), undefined, ['name'])
    const result = mapper({ id: 1, name: 'gone', data: '{"a":1}' })

    expect(result).toEqual({ id: 1, data: { a: 1 } })
    expect(result).not.toHaveProperty('name')
  })

  it('falls back to parsing Postgres array literal strings for jsonb', () => {
    const mapper = compileMapper(makeCols({ id: 'int4', data: 'jsonb' }))
    const result = mapper({ id: 1, data: '{"#### 1 ###","#    D   #","#    @   #","##########"}' })

    expect(result.data).toEqual(['#### 1 ###', '#    D   #', '#    @   #', '##########'])
  })

  it('parses Postgres array literal with numbers and nulls for jsonb', () => {
    const mapper = compileMapper(makeCols({ id: 'int4', data: 'jsonb' }))
    const result = mapper({ id: 1, data: '{1,NULL,3,true,false}' })

    expect(result.data).toEqual([1, null, 3, true, false])
  })

  it('returns the raw string when jsonb value is neither JSON nor a Postgres array', () => {
    const mapper = compileMapper(makeCols({ id: 'int4', data: 'jsonb' }))
    const result = mapper({ id: 1, data: 'not json at all' })

    expect(result.data).toBe('not json at all')
  })
})

describe('getOrCompileMapper cache key fingerprint', () => {
  it('treats pick column order as equivalent (sorted fingerprint)', () => {
    clearMapperCache()
    const cols = makeCols({ id: 'int4', name: 'text' })
    const m1 = getOrCompileMapper('t', cols, ['id', 'name'])
    const m2 = getOrCompileMapper('t', cols, ['name', 'id'])

    expect(m1).toBe(m2)
  })

  it('treats omit column order as equivalent (sorted fingerprint)', () => {
    clearMapperCache()
    const cols = makeCols({ id: 'int4', name: 'text', age: 'int4' })
    const m1 = getOrCompileMapper('t', cols, undefined, ['name', 'age'])
    const m2 = getOrCompileMapper('t', cols, undefined, ['age', 'name'])

    expect(m1).toBe(m2)
  })

  it('separates entries by pick vs omit even with same columns', () => {
    clearMapperCache()
    const cols = makeCols({ id: 'int4', name: 'text' })
    const m1 = getOrCompileMapper('t', cols, ['id'])
    const m2 = getOrCompileMapper('t', cols, undefined, ['name'])

    expect(m1).not.toBe(m2)
  })

  it('promotes recently-accessed entries (LRU touch)', () => {
    clearMapperCache()
    const cols = makeCols({ id: 'int4' })

    // Seed the cache
    const original = getOrCompileMapper('seed', cols, ['id'])

    // Fill cache to ~1000 entries while periodically touching the original
    for (let i = 0; i < 1100; i++) {
      getOrCompileMapper(`other_${i}`, cols, ['id'])

      if (i % 100 === 0)
        getOrCompileMapper('seed', cols, ['id']) // keep promoting
    }

    const seedAfter = getOrCompileMapper('seed', cols, ['id'])

    expect(seedAfter).toBe(original)
  })
})

describe('getOrCompileMapper cache key', () => {
  it('does not share a mapper between two tables that reuse one name', () => {
    clearMapperCache()

    const first = getOrCompileMapper('shared', makeCols({ id: 'int4', amount: 'int8' }))
    const second = getOrCompileMapper('shared', makeCols({ id: 'int4', label: 'jsonb' }))

    expect(second).not.toBe(first)
    expect(second({ id: 2, label: { a: 1 } })).toEqual({ id: 2, label: { a: 1 } })
  })
})
