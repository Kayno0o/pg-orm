import { describe, expect, test } from 'bun:test'
import { collectParentIds, groupBy, indexBy } from '../../../src/utils/collection'

describe('collectParentIds', () => {
  test('empty rows → empty array', () => {
    expect(collectParentIds([], 'id')).toEqual([])
  })

  test('single row → single id', () => {
    expect(collectParentIds([{ id: 1 }], 'id')).toEqual([1])
  })

  test('duplicate keys → encounter-order preserved, deduped', () => {
    const rows = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 1, name: 'c' },
      { id: 3, name: 'd' },
      { id: 2, name: 'e' },
    ]

    expect(collectParentIds(rows, 'id')).toEqual([1, 2, 3])
  })

  test('null values are skipped', () => {
    const rows = [{ fk: 1 }, { fk: null }, { fk: 2 }]

    expect(collectParentIds(rows, 'fk')).toEqual([1, 2])
  })

  test('undefined values are skipped', () => {
    const rows = [{ fk: 1 }, { fk: undefined }, { fk: 2 }]

    expect(collectParentIds(rows, 'fk')).toEqual([1, 2])
  })

  test('mixed nullables → only defined non-null kept', () => {
    const rows = [
      { fk: 1 },
      { fk: null },
      { fk: 2 },
      { fk: undefined },
      { fk: 1 },
      { fk: 3 },
    ]

    expect(collectParentIds(rows, 'fk')).toEqual([1, 2, 3])
  })

  test('missing key → undefined skipped', () => {
    const rows = [{ id: 1 }, { other: 2 } as Record<string, unknown>, { id: 3 }]

    expect(collectParentIds(rows, 'id')).toEqual([1, 3])
  })

  test('string ids deduped preserving order', () => {
    const rows = [{ k: 'b' }, { k: 'a' }, { k: 'b' }, { k: 'c' }]

    expect(collectParentIds(rows, 'k')).toEqual(['b', 'a', 'c'])
  })
})

describe('indexBy', () => {
  test('empty rows → empty map', () => {
    const m = indexBy<Record<string, unknown>>([], 'id')

    expect(m.size).toBe(0)
  })

  test('single row → single entry', () => {
    const m = indexBy([{ id: 1, name: 'a' }], 'id')

    expect(m.size).toBe(1)
    expect(m.get(1)).toEqual({ id: 1, name: 'a' })
  })

  test('duplicate keys → last wins', () => {
    const rows = [
      { id: 1, v: 'first' },
      { id: 2, v: 'b' },
      { id: 1, v: 'second' },
    ]
    const m = indexBy(rows, 'id')

    expect(m.size).toBe(2)
    expect(m.get(1)).toEqual({ id: 1, v: 'second' })
    expect(m.get(2)).toEqual({ id: 2, v: 'b' })
  })

  test('null key bucket retained (no skip)', () => {
    const rows = [{ k: 1, v: 'x' }, { k: null, v: 'y' }]
    const m = indexBy(rows, 'k')

    expect(m.size).toBe(2)
    expect(m.get(null)).toEqual({ k: null, v: 'y' })
  })
})

describe('groupBy', () => {
  test('empty rows → empty map', () => {
    const m = groupBy<Record<string, unknown>>([], 'k')

    expect(m.size).toBe(0)
  })

  test('single row → single bucket of size 1', () => {
    const m = groupBy([{ k: 1 }], 'k')

    expect(m.size).toBe(1)
    expect(m.get(1)).toEqual([{ k: 1 }])
  })

  test('multi-bucket with insertion order preserved per bucket', () => {
    const rows = [
      { k: 1, v: 'a' },
      { k: 2, v: 'b' },
      { k: 1, v: 'c' },
      { k: 2, v: 'd' },
      { k: 1, v: 'e' },
    ]
    const m = groupBy(rows, 'k')

    expect(m.size).toBe(2)
    expect(m.get(1)).toEqual([{ k: 1, v: 'a' }, { k: 1, v: 'c' }, { k: 1, v: 'e' }])
    expect(m.get(2)).toEqual([{ k: 2, v: 'b' }, { k: 2, v: 'd' }])
  })

  test('bucket order = first-seen-key order', () => {
    const rows = [{ k: 'b' }, { k: 'a' }, { k: 'b' }, { k: 'a' }]
    const m = groupBy(rows, 'k')

    expect([...m.keys()]).toEqual(['b', 'a'])
  })
})
