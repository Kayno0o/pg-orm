import type { AnyTableDef, HookRegistry } from '../../../src/types/index'
import { describe, expect, it } from 'bun:test'
import { hasHooks, runHooks, runHooksAsync } from '../../../src/hooks/index'

function makeTable(hooks: HookRegistry): AnyTableDef {
  return { name: 'test', columns: {}, relations: {}, virtuals: {}, hooks, primaryKey: null, meta: {} }
}

describe('runHooks (sync)', () => {
  it('returns value unchanged when no hooks', () => {
    const table = makeTable({})
    const result = runHooks(table, 'beforeInsert', { name: 'Alice' })

    expect(result).toEqual({ name: 'Alice' })
  })

  it('applies hook transformation', () => {
    const table = makeTable({
      beforeInsert: [row => ({ ...row, name: row.name.toUpperCase() })],
    })
    const result = runHooks(table, 'beforeInsert', { name: 'alice' })

    expect(result).toEqual({ name: 'ALICE' })
  })

  it('chains multiple hooks in order', () => {
    const table = makeTable({
      beforeInsert: [
        row => ({ ...row, a: 1 }),
        row => ({ ...row, b: 2 }),
      ],
    })
    const result = runHooks(table, 'beforeInsert', {})

    expect(result).toEqual({ a: 1, b: 2 })
  })

  it('skips hook result when returning undefined', () => {
    let called = false
    const table = makeTable({
      beforeInsert: [(_row) => { called = true }],
    })
    const result = runHooks(table, 'beforeInsert', { name: 'Alice' })

    expect(called).toBe(true)
    expect(result).toEqual({ name: 'Alice' })
  })

  it('skips hook result when returning null', () => {
    const table = makeTable({
      beforeInsert: [() => null],
    })
    const result = runHooks(table, 'beforeInsert', { name: 'Alice' })

    expect(result).toEqual({ name: 'Alice' })
  })
})

describe('runHooksAsync', () => {
  it('handles async hooks', async () => {
    const table = makeTable({
      beforeInsert: [async row => ({ ...row, processed: true })],
    })
    const result = await runHooksAsync(table, 'beforeInsert', { name: 'Alice' })

    expect(result).toEqual({ name: 'Alice', processed: true })
  })

  it('chains async hooks sequentially', async () => {
    const order: number[] = []
    const table = makeTable({
      beforeInsert: [
        async (row) => {
          order.push(1)

          return { ...row, a: 1 }
        },
        async (row) => {
          order.push(2)

          return { ...row, b: 2 }
        },
      ],
    })
    const result = await runHooksAsync(table, 'beforeInsert', {})

    expect(order).toEqual([1, 2])
    expect(result).toEqual({ a: 1, b: 2 })
  })

  it('returns value unchanged when no hooks', async () => {
    const table = makeTable({})
    const result = await runHooksAsync(table, 'afterSelect', [{ id: 1 }])

    expect(result).toEqual([{ id: 1 }])
  })
})

describe('hasHooks', () => {
  it('returns false when no hooks registered', () => {
    expect(hasHooks(makeTable({}), 'beforeInsert')).toBe(false)
  })

  it('returns false when hook array is empty', () => {
    expect(hasHooks(makeTable({ beforeInsert: [] }), 'beforeInsert')).toBe(false)
  })

  it('returns true when hooks registered', () => {
    expect(hasHooks(makeTable({ beforeInsert: [() => { /* noop */ }] }), 'beforeInsert')).toBe(true)
  })
})
