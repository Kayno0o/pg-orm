import { describe, expect, it } from 'bun:test'
import { OrmError } from '../../../src/errors/index'
import { asDriver, normalizeRows, serializeParams, unsafeQuery } from '../../../src/sql/adapter'

describe('asDriver', () => {
  it('returns the same reference (pure type cast)', () => {
    const noop = () => undefined
    const sql = { unsafe: noop, begin: noop, savepoint: noop, close: noop } as any
    const driver = asDriver(sql)

    expect(driver).toBe(sql)
  })
})

describe('serializeParams', () => {
  it('leaves non-array params untouched', () => {
    const params = [1, 'a', null, undefined, true, { x: 1 }, new Date(0)]
    const out = serializeParams(params)

    expect(out).toEqual(params)
    expect(out[5]).toBe(params[5]) // object identity preserved
  })

  it('serializes array params to PG array literals', () => {
    const out = serializeParams([1, ['a', 'b'], 'foo'])

    expect(out[0]).toBe(1)
    expect(out[1]).toBe('{"a","b"}')
    expect(out[2]).toBe('foo')
  })

  it('serializes empty array param', () => {
    expect(serializeParams([[]])[0]).toBe('{}')
  })

  it('handles nested array params', () => {
    expect(serializeParams([[[1, 2], [3]]])[0]).toBe('{{1,2},{3}}')
  })

  it('returns a new array (does not mutate input)', () => {
    const input = [[1]]
    const out = serializeParams(input)

    expect(out).not.toBe(input)
    expect(input[0]).toEqual([1]) // original array param untouched
  })
})

describe('normalizeRows', () => {
  it('converts Int32Array column values to plain arrays', () => {
    const rows = [{ id: 1, scores: new Int32Array([1, 2, 3]) }]
    const out = normalizeRows(rows)

    expect(Array.isArray(out[0]!.scores)).toBe(true)
    expect(out[0]!.scores).toEqual([1, 2, 3])
  })

  it('converts Float64Array values to plain arrays', () => {
    const rows = [{ values: new Float64Array([1.5, 2.25]) }]
    const out = normalizeRows(rows)

    expect(Array.isArray(out[0]!.values)).toBe(true)
    expect(out[0]!.values).toEqual([1.5, 2.25])
  })

  it('converts Uint8Array values to plain arrays', () => {
    const rows = [{ bytes: new Uint8Array([10, 20, 30]) }]
    const out = normalizeRows(rows)

    expect(Array.isArray(out[0]!.bytes)).toBe(true)
    expect(out[0]!.bytes).toEqual([10, 20, 30])
  })

  it('does NOT convert DataView values', () => {
    const buf = new ArrayBuffer(4)
    const view = new DataView(buf)
    const rows = [{ view }]
    const out = normalizeRows(rows)

    expect(out[0]!.view).toBe(view)
  })

  it('leaves plain arrays untouched', () => {
    const arr = [1, 2, 3]
    const rows = [{ values: arr }]
    const out = normalizeRows(rows)

    expect(out[0]!.values).toBe(arr)
  })

  it('leaves scalar values untouched', () => {
    const rows = [{ id: 1, name: 'Alice', flag: true, nullable: null }]
    const out = normalizeRows(rows)

    expect(out).toEqual([{ id: 1, name: 'Alice', flag: true, nullable: null }])
  })

  it('mutates and returns the same array', () => {
    const rows = [{ scores: new Int32Array([1]) }]
    const out = normalizeRows(rows)

    expect(out).toBe(rows)
  })

  it('handles empty rows', () => {
    expect(normalizeRows([])).toEqual([])
  })

  it('processes multiple rows independently', () => {
    const rows: Record<string, unknown>[] = [
      { id: 1, vals: new Int32Array([1, 2]) },
      { id: 2, vals: new Int32Array([3, 4]) },
    ]

    normalizeRows(rows)

    expect(rows[0]!.vals).toEqual([1, 2])
    expect(rows[1]!.vals).toEqual([3, 4])
  })
})

describe('unsafeQuery', () => {
  function makeSql(impl: (s: string, p: unknown[]) => unknown) {
    return { unsafe: async (s: string, p: unknown[]) => impl(s, p) } as any
  }

  it('serializes array params before calling unsafe', async () => {
    let received: unknown[] = []
    const sql = makeSql((_, p) => {
      received = p

      return []
    })

    await unsafeQuery(sql, 'SELECT 1', [[1, 2]])

    expect(received).toEqual(['{1,2}'])
  })

  it('returns normalized rows', async () => {
    const sql = makeSql(() => [{ vals: new Int32Array([7, 8]) }])
    const rows = await unsafeQuery(sql, 'SELECT vals FROM t', [])

    expect(Array.isArray(rows[0]!.vals)).toBe(true)
    expect(rows[0]!.vals).toEqual([7, 8])
  })

  it('wraps driver errors via wrapPgError', async () => {
    const sql = makeSql(() => {
      throw new Error('boom')
    })

    await expect(unsafeQuery(sql, 'SELECT bad', [])).rejects.toBeInstanceOf(OrmError)
  })

  it('passes sql string verbatim to driver', async () => {
    let receivedSql = ''
    const sql = makeSql((s) => {
      receivedSql = s

      return []
    })

    await unsafeQuery(sql, 'SELECT * FROM users WHERE id = $1', [1])

    expect(receivedSql).toBe('SELECT * FROM users WHERE id = $1')
  })
})
