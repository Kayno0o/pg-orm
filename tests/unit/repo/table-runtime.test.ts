import type { HookContext } from '../../../src/types/index'
import { describe, expect, it } from 'bun:test'
import { AfterHookError, BeforeHookError, OrmError } from '../../../src/errors/index'
import { defineTable } from '../../../src/index'
import { buildTableRuntime } from '../../../src/repo/table-runtime'

const ctx = {} as HookContext

function makePlain() {
  return defineTable('plain', t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
  }))
}

function makePeople() {
  return defineTable('people', t => ({
    id: t.serial().primaryKey(),
    firstName: t.text().notNull(),
    lastName: t.text().notNull(),
  })).withVirtuals({
    fullName: row => `${row.firstName} ${row.lastName}`,
  })
}

describe('buildTableRuntime: core fields', () => {
  it('exposes the table and primary key', () => {
    const rt = buildTableRuntime(makePlain())

    expect(rt.table.name).toBe('plain')
    expect(rt.primaryKey).toBe('id')
  })

  it('exposes a frozen behavior object derived from the same table', () => {
    const table = makePlain()
    const rt = buildTableRuntime(table)

    expect(rt.behavior).toBeDefined()
    expect(Object.isFrozen(rt.behavior)).toBe(true)
    expect(rt.behavior.getSoftDeleteColumn()).toBeNull()
    expect(rt.behavior.getOptimisticLockColumn()).toBeNull()
  })

  it('is frozen — runtime fields cannot be mutated', () => {
    const rt = buildTableRuntime(makePlain())

    expect(Object.isFrozen(rt)).toBe(true)
  })
})

describe('buildTableRuntime.runBefore', () => {
  it('returns the value unchanged when no hooks are registered', async () => {
    const rt = buildTableRuntime(makePlain())
    const input = { name: 'Alice' }

    expect(await rt.runBefore('beforeInsert', input, ctx)).toBe(input)
  })

  it('runs a single hook and returns its mutated value', async () => {
    const t = makePlain()

    t.hook('beforeInsert', row => ({ ...row, name: row.name.toUpperCase() }))
    const rt = buildTableRuntime(t)

    expect(await rt.runBefore('beforeInsert', { name: 'alice' }, ctx)).toEqual({ name: 'ALICE' })
  })

  it('chains multiple hooks in sequence', async () => {
    const t = makePlain()

    t.hook('beforeInsert', row => ({ ...row, name: `${row.name}-a` }))
    t.hook('beforeInsert', row => ({ ...row, name: `${row.name}-b` }))
    const rt = buildTableRuntime(t)

    expect(await rt.runBefore('beforeInsert', { name: 'x' }, ctx)).toEqual({ name: 'x-a-b' })
  })

  it('wraps a throwing before-hook in BeforeHookError', async () => {
    const t = makePlain()

    t.hook('beforeInsert', () => {
      throw new Error('boom')
    })
    const rt = buildTableRuntime(t)

    await expect(rt.runBefore('beforeInsert', { name: 'x' }, ctx)).rejects.toBeInstanceOf(BeforeHookError)
  })
})

describe('buildTableRuntime.runBeforeMany', () => {
  it('returns the input array reference when no hooks are registered', async () => {
    const rt = buildTableRuntime(makePlain())
    const arr = [{ name: 'a' }, { name: 'b' }]

    expect(await rt.runBeforeMany('beforeInsert', arr, ctx)).toBe(arr)
  })

  it('applies hook to each element in parallel', async () => {
    const t = makePlain()

    t.hook('beforeInsert', async row => ({ ...row, name: row.name.toUpperCase() }))
    const rt = buildTableRuntime(t)

    const out = await rt.runBeforeMany('beforeInsert', [{ name: 'a' }, { name: 'b' }, { name: 'c' }], ctx)

    expect(out.map(r => r.name)).toEqual(['A', 'B', 'C'])
  })
})

describe('buildTableRuntime.runAfter', () => {
  it('is a no-op when no hooks are registered', async () => {
    const rt = buildTableRuntime(makePlain())

    await expect(rt.runAfter('afterInsert', [], ctx)).resolves.toBeUndefined()
  })

  it('wraps a throwing after-hook in AfterHookError', async () => {
    const t = makePlain()

    t.hook('afterInsert', () => {
      throw new Error('boom')
    })
    const rt = buildTableRuntime(t)

    await expect(rt.runAfter('afterInsert', [], ctx)).rejects.toBeInstanceOf(AfterHookError)
    await expect(rt.runAfter('afterInsert', [], ctx)).rejects.toMatchObject({
      table: 'plain',
      hook: 'afterInsert',
      committed: true,
    })
  })
})

describe('buildTableRuntime.applyVirtuals', () => {
  it('returns the same array when the table has no virtuals', () => {
    const rt = buildTableRuntime(makePlain())
    const rows = [{ id: 1, name: 'x' }]

    expect(rt.applyVirtuals(rows)).toBe(rows)
  })

  it('installs a lazy getter that computes on first read', () => {
    const rt = buildTableRuntime(makePeople())
    const rows = [{ id: 1, firstName: 'Ada', lastName: 'Lovelace' }]

    rt.applyVirtuals(rows)
    expect((rows[0] as any).fullName).toBe('Ada Lovelace')
  })

  it('memoizes the computed value (called once across multiple reads)', () => {
    let calls = 0
    const t = defineTable('memo', col => ({ id: col.serial().primaryKey() })).withVirtuals({
      v: () => {
        calls++

        return calls
      },
    })
    const rt = buildTableRuntime(t)
    const rows = [{ id: 1 }]

    rt.applyVirtuals(rows)
    const r = rows[0] as any

    expect(r.v).toBe(1)
    expect(r.v).toBe(1)
    expect(r.v).toBe(1)
    expect(calls).toBe(1)
  })

  it('wraps compute errors in OrmError with table name + PK', () => {
    const t = defineTable('bad', col => ({ id: col.serial().primaryKey() })).withVirtuals({
      boom: () => {
        throw new Error('inner explosion')
      },
    })
    const rt = buildTableRuntime(t)
    const rows = [{ id: 42 }]

    rt.applyVirtuals(rows)

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

  it('two runtimes for the same table identity have independent virtual entries (no shared state)', () => {
    const t = makePeople()
    const rtA = buildTableRuntime(t)
    const rtB = buildTableRuntime(t)
    const rowsA = [{ id: 1, firstName: 'A', lastName: 'B' }]
    const rowsB = [{ id: 1, firstName: 'C', lastName: 'D' }]

    rtA.applyVirtuals(rowsA)
    rtB.applyVirtuals(rowsB)

    expect((rowsA[0] as any).fullName).toBe('A B')
    expect((rowsB[0] as any).fullName).toBe('C D')
  })
})
