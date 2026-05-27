import { describe, expect, it } from 'bun:test'
import { OrmError } from '../../../src/errors/index'
import { defineTable } from '../../../src/index'
import { applyVirtuals, VirtualEntriesCache } from '../../../src/repo/virtuals'

function makePeople() {
  return defineTable('people', t => ({
    id: t.serial().primaryKey(),
    firstName: t.text().notNull(),
    lastName: t.text().notNull(),
  })).withVirtuals({
    fullName: row => `${row.firstName} ${row.lastName}`,
  })
}

function cache() {
  return new VirtualEntriesCache()
}

describe('applyVirtuals', () => {
  it('returns the same array when the table has no virtuals', () => {
    const t = defineTable('bare', col => ({ id: col.serial().primaryKey() }))
    const rows = [{ id: 1 }]
    const out = applyVirtuals(t, rows, cache())

    expect(out).toBe(rows)
    expect(out[0]).toEqual({ id: 1 })
  })

  it('installs a lazy getter that computes on first read', () => {
    const t = makePeople()
    let calls = 0
    const t2 = t.withVirtuals({
      counted: () => {
        calls++

        return 'value'
      },
    })

    const rows = [{ id: 1, firstName: 'A', lastName: 'B' }]

    applyVirtuals(t2, rows, cache())
    expect(calls).toBe(0) // not computed yet
    expect((rows[0] as any).counted).toBe('value')
    expect(calls).toBe(1)
  })

  it('memoizes the computed value (compute called once across multiple reads)', () => {
    let calls = 0
    const t = defineTable('memo', col => ({ id: col.serial().primaryKey() })).withVirtuals({
      v: () => {
        calls++

        return calls // returns increasing counter so we can detect a recompute
      },
    })

    const rows = [{ id: 1 }]

    applyVirtuals(t, rows, cache())
    const r = rows[0] as any

    expect(r.v).toBe(1)
    expect(r.v).toBe(1) // still 1 — getter replaced with materialized value
    expect(r.v).toBe(1)
    expect(calls).toBe(1)
  })

  it('computes virtuals using row data', () => {
    const t = makePeople()
    const rows = [
      { id: 1, firstName: 'Ada', lastName: 'Lovelace' },
      { id: 2, firstName: 'Alan', lastName: 'Turing' },
    ]

    applyVirtuals(t, rows, cache())
    expect((rows[0] as any).fullName).toBe('Ada Lovelace')
    expect((rows[1] as any).fullName).toBe('Alan Turing')
  })

  it('wraps compute errors in OrmError with table name + PK', () => {
    const t = defineTable('bad', col => ({
      id: col.serial().primaryKey(),
    })).withVirtuals({
      boom: () => {
        throw new Error('inner explosion')
      },
    })
    const rows = [{ id: 42 }]

    applyVirtuals(t, rows, cache())

    try {
      void (rows[0] as any).boom

      throw new Error('should have thrown')
    }
    catch (err) {
      expect(err).toBeInstanceOf(OrmError)
      expect((err as Error).message).toContain('boom')
      expect((err as Error).message).toContain('bad.id=42')
      expect((err as Error).message).toContain('inner explosion')
    }
  })

  it('formats string PK values with quotes in error message', () => {
    const t = defineTable('uuidtbl', col => ({
      id: col.text().primaryKey(),
    })).withVirtuals({
      boom: () => {
        throw new Error('x')
      },
    })
    const rows = [{ id: 'abc-123' }]

    applyVirtuals(t, rows, cache())

    try {
      void (rows[0] as any).boom

      throw new Error('should have thrown')
    }
    catch (err) {
      expect((err as Error).message).toContain('uuidtbl.id="abc-123"')
    }
  })

  it('formats null PK values as "null" in error message', () => {
    const t = defineTable('nullable', col => ({
      id: col.int4().primaryKey(),
    })).withVirtuals({
      boom: () => {
        throw new Error('x')
      },
    })
    const rows = [{ id: null }]

    applyVirtuals(t, rows, cache())

    try {
      void (rows[0] as any).boom

      throw new Error('should have thrown')
    }
    catch (err) {
      expect((err as Error).message).toContain('nullable.id=null')
    }
  })

  it('falls back to a generic ref when row has no PK column value', () => {
    const t = defineTable('orphan', col => ({
      id: col.int4().primaryKey(),
    })).withVirtuals({
      boom: () => {
        throw new Error('x')
      },
    })
    const rows = [{} as { id: number }]

    applyVirtuals(t, rows, cache())

    try {
      void (rows[0] as any).boom

      throw new Error('should have thrown')
    }
    catch (err) {
      expect((err as Error).message).toContain('row in table "orphan"')
    }
  })

  it('handles non-Error throws (e.g. plain strings)', () => {
    const t = defineTable('strthrow', col => ({
      id: col.serial().primaryKey(),
    })).withVirtuals({
      boom: () => {
        // eslint-disable-next-line no-throw-literal
        throw 'just a string'
      },
    })
    const rows = [{ id: 1 }]

    applyVirtuals(t, rows, cache())

    try {
      void (rows[0] as any).boom

      throw new Error('should have thrown')
    }
    catch (err) {
      expect(err).toBeInstanceOf(OrmError)
      expect((err as Error).message).toContain('just a string')
    }
  })

  it('JSON.stringify omits virtual getters until they are accessed (lazy)', () => {
    const t = makePeople()
    const rows = [{ id: 1, firstName: 'A', lastName: 'B' }]

    applyVirtuals(t, rows, cache())

    // Defining a getter doesn't show the property until it's been read;
    // JSON.stringify still includes it because it's enumerable + configurable.
    // After serialization the value should be materialized.
    const json = JSON.parse(JSON.stringify(rows[0]))

    expect(json.fullName).toBe('A B')
  })
})

describe('VirtualEntriesCache', () => {
  it('caches entries per table (returns same reference on repeated lookup)', () => {
    const c = new VirtualEntriesCache()
    const t = makePeople()
    const e1 = c.entries(t)
    const e2 = c.entries(t)

    expect(e1).toBe(e2)
  })

  it('returns empty array for tables without virtuals', () => {
    const c = new VirtualEntriesCache()
    const t = defineTable('empty', col => ({ id: col.serial().primaryKey() }))

    expect(c.entries(t)).toEqual([])
  })

  it('two cache instances are independent (no shared module state)', () => {
    const t = makePeople()
    const a = new VirtualEntriesCache()
    const b = new VirtualEntriesCache()

    const fromA = a.entries(t)
    const fromB = b.entries(t)

    // Different identity — proves the cache is per-instance, not module-scoped.
    expect(fromA).not.toBe(fromB)
    // But the content is the same shape.
    expect(fromA.map(([k]) => k)).toEqual(fromB.map(([k]) => k))
  })

  it('clear() forces re-computation of entries on next read', () => {
    const c = new VirtualEntriesCache()
    const t = makePeople()
    const before = c.entries(t)

    c.clear()
    const after = c.entries(t)

    expect(after).not.toBe(before)
    expect(after.length).toBe(before.length)
  })
})
