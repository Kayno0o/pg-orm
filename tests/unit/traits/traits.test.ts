import { describe, expect, it } from 'bun:test'
import { defineTable, optimisticLock, softDelete, timestamps } from '../../../src/index'
import { applyTrait } from '../../../src/traits/index'

describe('softDelete trait', () => {
  it('adds deletedAt column', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(softDelete())

    expect((table.columns as any).deletedAt).toBeDefined()
    expect((table.columns as any).deletedAt.pgType).toBe('timestamptz')
  })

  it('adds isDeleted virtual', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(softDelete())

    expect((table.virtuals as any).isDeleted).toBeDefined()
    expect((table.virtuals as any).isDeleted.compute({ deletedAt: new Date() })).toBe(true)
    expect((table.virtuals as any).isDeleted.compute({ deletedAt: null })).toBe(false)
  })

  it('sets softDelete meta', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(softDelete())

    expect(table.meta.softDelete).toEqual({ column: 'deletedAt' })
  })

  it('supports custom column name', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(softDelete('removedAt'))

    expect((table.columns as any).removedAt).toBeDefined()
    expect(table.meta.softDelete).toEqual({ column: 'removedAt' })
  })
})

describe('optimisticLock trait', () => {
  it('adds version column', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(optimisticLock())

    expect((table.columns as any).version).toBeDefined()
    expect((table.columns as any).version.pgType).toBe('int4')
  })

  it('sets optimisticLock meta', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(optimisticLock())

    expect(table.meta.optimisticLock).toEqual({ column: 'version' })
  })

  it('supports custom column name', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(optimisticLock('rev'))

    expect((table.columns as any).rev).toBeDefined()
    expect(table.meta.optimisticLock).toEqual({ column: 'rev' })
  })
})

describe('timestamps trait', () => {
  it('adds createdAt and updatedAt columns', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(timestamps())

    expect((table.columns as any).createdAt).toBeDefined()
    expect((table.columns as any).updatedAt).toBeDefined()
    expect((table.columns as any).createdAt.pgType).toBe('timestamptz')
  })

  it('sets timestamps meta', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(timestamps())

    expect(table.meta.timestamps).toEqual({ createdAt: 'createdAt', updatedAt: 'updatedAt' })
  })

  it('registers beforeUpdate hook', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(timestamps())

    expect(table.hooks.beforeUpdate).toHaveLength(1)
  })

  it('beforeUpdate hook sets updatedAt', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(timestamps())
    const hook = table.hooks.beforeUpdate![0]!
    const before = new Date()
    const row: any = { name: 'test' }
    const result = hook(row) as any

    expect(result.updatedAt).toBeInstanceOf(Date)
    expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
  })

  it('supports custom column names', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    table.withTrait(timestamps({ createdAt: 'created', updatedAt: 'updated' }))

    expect((table.columns as any).created).toBeDefined()
    expect((table.columns as any).updated).toBeDefined()
    expect(table.meta.timestamps).toEqual({ createdAt: 'created', updatedAt: 'updated' })
  })
})

describe('applyTrait', () => {
  it('merges custom trait', () => {
    const table = defineTable('test', t => ({ id: t.serial().primaryKey() }))

    applyTrait(table, {
      columns: t => ({ extra: t.text().nullable() }),
      meta: { custom: true },
    })

    expect((table.columns as any).extra).toBeDefined()
    expect(table.meta.custom).toBe(true)
  })
})
