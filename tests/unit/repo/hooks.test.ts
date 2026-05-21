import { describe, expect, it } from 'bun:test'
import { AfterHookError } from '../../../src/errors/index'
import { defineTable } from '../../../src/index'
import { HookOrchestrator } from '../../../src/repo/hooks'

function makeTable() {
  return defineTable('hooked', t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
  }))
}

describe('HookOrchestrator.runBefore', () => {
  it('returns the value unchanged when no hooks are registered', async () => {
    const t = makeTable()
    const orch = new HookOrchestrator(t)
    const input = { name: 'Alice' }
    const result = await orch.runBefore('beforeInsert', input)

    expect(result).toBe(input)
  })

  it('runs a single hook and returns its mutated value', async () => {
    const t = makeTable()

    t.hook('beforeInsert', row => ({ ...row, name: row.name.toUpperCase() }))

    const orch = new HookOrchestrator(t)
    const result = await orch.runBefore('beforeInsert', { name: 'alice' })

    expect(result).toEqual({ name: 'ALICE' })
  })

  it('runs multiple hooks in sequence (output of one feeds the next)', async () => {
    const t = makeTable()

    t.hook('beforeInsert', row => ({ ...row, name: `${row.name}-a` }))
    t.hook('beforeInsert', row => ({ ...row, name: `${row.name}-b` }))

    const orch = new HookOrchestrator(t)
    const result = await orch.runBefore('beforeInsert', { name: 'x' })

    expect(result).toEqual({ name: 'x-a-b' })
  })

  it('awaits async hooks', async () => {
    const t = makeTable()

    t.hook('beforeInsert', async row => ({ ...row, name: `${row.name}!` }))

    const orch = new HookOrchestrator(t)
    const result = await orch.runBefore('beforeInsert', { name: 'x' })

    expect(result).toEqual({ name: 'x!' })
  })
})

describe('HookOrchestrator.runBeforeMany', () => {
  it('returns the same array reference when no hooks are registered', async () => {
    const t = makeTable()
    const orch = new HookOrchestrator(t)
    const arr = [{ name: 'a' }, { name: 'b' }]
    const out = await orch.runBeforeMany('beforeInsert', arr)

    expect(out).toBe(arr)
  })

  it('applies hook to each element in parallel', async () => {
    const t = makeTable()
    let order: string[] = []

    t.hook('beforeInsert', async (row) => {
      order.push(`start:${row.name}`)
      await new Promise(r => setTimeout(r, 1))
      order.push(`end:${row.name}`)

      return { ...row, name: row.name.toUpperCase() }
    })

    const orch = new HookOrchestrator(t)

    order = []
    const out = await orch.runBeforeMany('beforeInsert', [{ name: 'a' }, { name: 'b' }, { name: 'c' }])

    expect(out.map(r => r.name)).toEqual(['A', 'B', 'C'])
    // Parallel: all three should start before any finishes
    expect(order.slice(0, 3).every(s => s.startsWith('start:'))).toBe(true)
  })

  it('returns empty array when input is empty (no hooks branch)', async () => {
    const t = makeTable()
    const orch = new HookOrchestrator(t)
    const out = await orch.runBeforeMany('beforeInsert', [] as { name: string }[])

    expect(out).toEqual([])
  })

  it('handles empty array with hooks present', async () => {
    const t = makeTable()

    t.hook('beforeInsert', row => row)

    const orch = new HookOrchestrator(t)
    const out = await orch.runBeforeMany('beforeInsert', [])

    expect(out).toEqual([])
  })
})

describe('HookOrchestrator.runAfter', () => {
  it('is a no-op when no hooks are registered', async () => {
    const t = makeTable()
    const orch = new HookOrchestrator(t)

    await expect(orch.runAfter('afterInsert', [])).resolves.toBeUndefined()
  })

  it('invokes after-hooks with the rows argument', async () => {
    const t = makeTable()
    let received: unknown

    t.hook('afterInsert', (rows) => {
      received = rows
    })

    const orch = new HookOrchestrator(t)
    const rows = [{ id: 1, name: 'a' }]

    await orch.runAfter('afterInsert', rows)
    expect(received).toBe(rows)
  })

  it('wraps a throwing after-hook in AfterHookError with table + hook name', async () => {
    const t = makeTable()

    t.hook('afterInsert', () => {
      throw new Error('boom')
    })

    const orch = new HookOrchestrator(t)

    await expect(orch.runAfter('afterInsert', [])).rejects.toBeInstanceOf(AfterHookError)
    await expect(orch.runAfter('afterInsert', [])).rejects.toMatchObject({
      table: 'hooked',
      hook: 'afterInsert',
      committed: true,
    })
  })

  it('wraps async-throwing after-hooks too', async () => {
    const t = makeTable()

    t.hook('afterDelete', async () => {
      throw new Error('async boom')
    })

    const orch = new HookOrchestrator(t)

    await expect(orch.runAfter('afterDelete')).rejects.toBeInstanceOf(AfterHookError)
  })

  it('wraps non-Error throws too', async () => {
    const t = makeTable()

    t.hook('afterUpdate', () => {
      // eslint-disable-next-line no-throw-literal
      throw 'string-thrown'
    })

    const orch = new HookOrchestrator(t)

    await expect(orch.runAfter('afterUpdate', [])).rejects.toBeInstanceOf(AfterHookError)
  })
})
