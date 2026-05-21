import { describe, expect, it } from 'bun:test'
import { SelectBuilder } from '../../../src/builder/select'
import { OrmError } from '../../../src/errors/index'
import { defineTable, optimisticLock, softDelete, timestamps } from '../../../src/index'
import {
  applySoftDeleteFilter,
  getOptimisticLockColumn,
  getSoftDeleteColumn,
  getTraitMeta,
  requireSoftDeleteColumn,
} from '../../../src/repo/traits'

const plainTable = defineTable('plain', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const softTable = defineTable('soft', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
})).withTrait(softDelete())

const optTable = defineTable('opt', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
})).withTrait(optimisticLock())

const fullTable = defineTable('full', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))
  .withTrait(softDelete())
  .withTrait(optimisticLock())
  .withTrait(timestamps())

describe('getTraitMeta', () => {
  it('returns all undefined for a plain table', () => {
    const meta = getTraitMeta(plainTable)

    expect(meta.softDelete).toBeUndefined()
    expect(meta.optimisticLock).toBeUndefined()
    expect(meta.timestamps).toBeUndefined()
  })

  it('returns softDelete metadata when trait applied', () => {
    const meta = getTraitMeta(softTable)

    expect(meta.softDelete).toBeDefined()
    expect(meta.softDelete!.column).toBeTruthy()
  })

  it('returns all three trait metadata fields when all applied', () => {
    const meta = getTraitMeta(fullTable)

    expect(meta.softDelete).toBeDefined()
    expect(meta.optimisticLock).toBeDefined()
    expect(meta.timestamps).toBeDefined()
    expect(typeof meta.timestamps!.createdAt).toBe('string')
    expect(typeof meta.timestamps!.updatedAt).toBe('string')
  })
})

describe('getOptimisticLockColumn', () => {
  it('returns null on a plain table', () => {
    expect(getOptimisticLockColumn(plainTable)).toBeNull()
  })

  it('returns the column name on a table with optimisticLock trait', () => {
    const col = getOptimisticLockColumn(optTable)

    expect(typeof col).toBe('string')
    expect(col).toBeTruthy()
  })
})

describe('getSoftDeleteColumn', () => {
  it('returns null on a plain table', () => {
    expect(getSoftDeleteColumn(plainTable)).toBeNull()
  })

  it('returns the column name on a soft-delete table', () => {
    expect(typeof getSoftDeleteColumn(softTable)).toBe('string')
    expect(getSoftDeleteColumn(softTable)!.length).toBeGreaterThan(0)
  })
})

describe('requireSoftDeleteColumn', () => {
  it('throws OrmError on a plain table with the operation name in the message', () => {
    try {
      requireSoftDeleteColumn(plainTable, 'restore')

      throw new Error('should have thrown')
    }
    catch (err) {
      expect(err).toBeInstanceOf(OrmError)
      expect((err as Error).message).toContain('restore')
      expect((err as Error).message).toContain('softDelete')
    }
  })

  it('returns the column name on a soft-delete table', () => {
    const col = requireSoftDeleteColumn(softTable, 'restore')

    expect(typeof col).toBe('string')
    expect(col).toBe(getSoftDeleteColumn(softTable) as string)
  })
})

describe('applySoftDeleteFilter', () => {
  it('is a no-op on a plain table', () => {
    const builder = new SelectBuilder<any, any>('plain')
    const beforeWhere = builder.getState().whereTape

    applySoftDeleteFilter(plainTable, builder)
    expect(builder.getState().whereTape).toBe(beforeWhere)
  })

  it('adds an IS NULL filter on a soft-delete table without withTrashed', () => {
    const builder = new SelectBuilder<any, any>('soft')

    applySoftDeleteFilter(softTable, builder)
    const { sql } = builder.toSQL()
    const col = getSoftDeleteColumn(softTable)!

    expect(sql).toContain(`"${col}" IS NULL`)
  })

  it('is a no-op when withTrashed() is set', () => {
    const builder = new SelectBuilder<any, any>('soft').withTrashed()
    const beforeWhere = builder.getState().whereTape

    applySoftDeleteFilter(softTable, builder)
    expect(builder.getState().whereTape).toBe(beforeWhere)
    expect(builder.toSQL().sql).not.toContain('IS NULL')
  })
})
