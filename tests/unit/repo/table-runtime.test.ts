import { describe, expect, it } from 'bun:test'
import { SelectBuilder, UpdateBuilder } from '../../../src/builder/query'
import { AfterHookError, BeforeHookError, OrmError } from '../../../src/errors/index'
import { defineTable, optimisticLock, softDelete } from '../../../src/index'
import { buildTableRuntime } from '../../../src/repo/table-runtime'

function makePlain() {
  return defineTable('plain', t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
  }))
}

function makeSoft() {
  return defineTable('soft', t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
  })).withTrait(softDelete())
}

function makeOpt() {
  return defineTable('opt', t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
  })).withTrait(optimisticLock())
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

describe('buildTableRuntime: trait fields', () => {
  it('exposes null trait columns for plain tables', () => {
    const rt = buildTableRuntime(makePlain())

    expect(rt.hasSoftDelete).toBe(false)
    expect(rt.hasOptimisticLock).toBe(false)
    expect(rt.softDeleteColumn).toBeNull()
    expect(rt.optimisticLockColumn).toBeNull()
  })

  it('exposes the soft-delete column name when the trait is applied', () => {
    const rt = buildTableRuntime(makeSoft())

    expect(rt.hasSoftDelete).toBe(true)
    expect(typeof rt.softDeleteColumn).toBe('string')
    expect(rt.softDeleteColumn!.length).toBeGreaterThan(0)
  })

  it('exposes the optimistic-lock column name when the trait is applied', () => {
    const rt = buildTableRuntime(makeOpt())

    expect(rt.hasOptimisticLock).toBe(true)
    expect(typeof rt.optimisticLockColumn).toBe('string')
    expect(rt.optimisticLockColumn!.length).toBeGreaterThan(0)
  })

  it('returns the table primary key (defaulting to id)', () => {
    expect(buildTableRuntime(makePlain()).primaryKey).toBe('id')
  })

  it('is frozen — runtime fields cannot be mutated', () => {
    const rt = buildTableRuntime(makePlain())

    expect(Object.isFrozen(rt)).toBe(true)
  })
})

describe('buildTableRuntime.applyPreSelect', () => {
  it('is a no-op on a plain table', () => {
    const rt = buildTableRuntime(makePlain())
    const b = new SelectBuilder<any, any>('plain')
    const before = b.getState().whereTape

    rt.applyPreSelect(b)
    expect(b.getState().whereTape).toBe(before)
  })

  it('adds an IS NULL filter for the soft-delete column', () => {
    const t = makeSoft()
    const rt = buildTableRuntime(t)
    const b = new SelectBuilder<any, any>('soft')

    rt.applyPreSelect(b)
    const { sql } = b.toSQL()

    expect(sql).toContain(`"${rt.softDeleteColumn!}" IS NULL`)
  })

  it('respects withTrashed() and skips the IS NULL filter', () => {
    const rt = buildTableRuntime(makeSoft())
    const b = new SelectBuilder<any, any>('soft').withTrashed()
    const before = b.getState().whereTape

    rt.applyPreSelect(b)
    expect(b.getState().whereTape).toBe(before)
    expect(b.toSQL().sql).not.toContain('IS NULL')
  })
})

describe('buildTableRuntime.applyPreUpdate', () => {
  it('is a no-op on a plain table', () => {
    const rt = buildTableRuntime(makePlain())
    const b = new UpdateBuilder<any>('plain').set({ name: 'x' }).where(e => e.eq('id', 1))
    const sqlBefore = b.toSQL().sql

    rt.applyPreUpdate(b)
    expect(b.toSQL().sql).toBe(sqlBefore)
  })

  it('appends a version-bump for the optimistic-lock column', () => {
    const rt = buildTableRuntime(makeOpt())
    const b = new UpdateBuilder<any>('opt').set({ name: 'x' }).where(e => e.eq('id', 1))

    rt.applyPreUpdate(b)
    const { sql } = b.toSQL()
    const col = rt.optimisticLockColumn!

    expect(sql).toContain(`"${col}" = "${col}" + 1`)
  })
})

describe('buildTableRuntime.rewriteDelete', () => {
  it('returns null on a plain table', () => {
    const rt = buildTableRuntime(makePlain())

    expect(rt.rewriteDelete(e => e.eq('id', 1))).toBeNull()
  })

  it('returns an UpdateBuilder that sets the soft-delete column when the trait is applied', () => {
    const rt = buildTableRuntime(makeSoft())
    const ub = rt.rewriteDelete(e => e.eq('id', 1))

    expect(ub).not.toBeNull()
    const { sql } = ub!.toSQL()
    const col = rt.softDeleteColumn!

    expect(sql).toContain(`UPDATE "soft" SET "${col}" =`)
    expect(sql).toContain('RETURNING')
  })
})

describe('buildTableRuntime.requireSoftDeleteColumn', () => {
  it('throws OrmError on a plain table with the operation name in the message', () => {
    const rt = buildTableRuntime(makePlain())

    try {
      rt.requireSoftDeleteColumn('restore')

      throw new Error('should have thrown')
    }
    catch (err) {
      expect(err).toBeInstanceOf(OrmError)
      expect((err as Error).message).toContain('restore')
      expect((err as Error).message).toContain('softDelete')
    }
  })

  it('returns the column name on a soft-delete table', () => {
    const rt = buildTableRuntime(makeSoft())

    expect(rt.requireSoftDeleteColumn('restore')).toBe(rt.softDeleteColumn!)
  })
})

describe('buildTableRuntime.runBefore', () => {
  it('returns the value unchanged when no hooks are registered', async () => {
    const rt = buildTableRuntime(makePlain())
    const input = { name: 'Alice' }

    expect(await rt.runBefore('beforeInsert', input)).toBe(input)
  })

  it('runs a single hook and returns its mutated value', async () => {
    const t = makePlain()

    t.hook('beforeInsert', row => ({ ...row, name: row.name.toUpperCase() }))
    const rt = buildTableRuntime(t)

    expect(await rt.runBefore('beforeInsert', { name: 'alice' })).toEqual({ name: 'ALICE' })
  })

  it('chains multiple hooks in sequence', async () => {
    const t = makePlain()

    t.hook('beforeInsert', row => ({ ...row, name: `${row.name}-a` }))
    t.hook('beforeInsert', row => ({ ...row, name: `${row.name}-b` }))
    const rt = buildTableRuntime(t)

    expect(await rt.runBefore('beforeInsert', { name: 'x' })).toEqual({ name: 'x-a-b' })
  })

  it('wraps a throwing before-hook in BeforeHookError', async () => {
    const t = makePlain()

    t.hook('beforeInsert', () => {
      throw new Error('boom')
    })
    const rt = buildTableRuntime(t)

    await expect(rt.runBefore('beforeInsert', { name: 'x' })).rejects.toBeInstanceOf(BeforeHookError)
  })
})

describe('buildTableRuntime.runBeforeMany', () => {
  it('returns the input array reference when no hooks are registered', async () => {
    const rt = buildTableRuntime(makePlain())
    const arr = [{ name: 'a' }, { name: 'b' }]

    expect(await rt.runBeforeMany('beforeInsert', arr)).toBe(arr)
  })

  it('applies hook to each element in parallel', async () => {
    const t = makePlain()

    t.hook('beforeInsert', async row => ({ ...row, name: row.name.toUpperCase() }))
    const rt = buildTableRuntime(t)

    const out = await rt.runBeforeMany('beforeInsert', [{ name: 'a' }, { name: 'b' }, { name: 'c' }])

    expect(out.map(r => r.name)).toEqual(['A', 'B', 'C'])
  })
})

describe('buildTableRuntime.runAfter', () => {
  it('is a no-op when no hooks are registered', async () => {
    const rt = buildTableRuntime(makePlain())

    await expect(rt.runAfter('afterInsert', [])).resolves.toBeUndefined()
  })

  it('wraps a throwing after-hook in AfterHookError', async () => {
    const t = makePlain()

    t.hook('afterInsert', () => {
      throw new Error('boom')
    })
    const rt = buildTableRuntime(t)

    await expect(rt.runAfter('afterInsert', [])).rejects.toBeInstanceOf(AfterHookError)
    await expect(rt.runAfter('afterInsert', [])).rejects.toMatchObject({
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
