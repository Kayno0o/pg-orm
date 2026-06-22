import { describe, expect, it } from 'bun:test'
import { SelectBuilder, UpdateBuilder } from '../../../src/builder/query'
import { OrmError } from '../../../src/errors/index'
import { defineTable, optimisticLock, softDelete } from '../../../src/index'
import { buildTableBehavior } from '../../../src/repo/table-behavior'

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

function makeSoftOpt() {
  return defineTable('softOpt', t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
  })).withTrait(softDelete()).withTrait(optimisticLock())
}

describe('buildTableBehavior: trait fields', () => {
  it('exposes null trait columns for plain tables', () => {
    const behavior = buildTableBehavior(makePlain())

    expect(behavior.getSoftDeleteColumn()).toBeNull()
    expect(behavior.getOptimisticLockColumn()).toBeNull()
  })

  it('exposes the soft-delete column name when the trait is applied', () => {
    const behavior = buildTableBehavior(makeSoft())

    expect(behavior.getSoftDeleteColumn()).toBe('deletedAt')
  })

  it('exposes the optimistic-lock column name when the trait is applied', () => {
    const behavior = buildTableBehavior(makeOpt())

    expect(behavior.getOptimisticLockColumn()).toBe('version')
  })

  it('is frozen — behavior fields cannot be mutated', () => {
    const behavior = buildTableBehavior(makePlain())

    expect(Object.isFrozen(behavior)).toBe(true)
  })
})

describe('buildTableBehavior.prepareSelect', () => {
  it('is a no-op on a plain table', () => {
    const behavior = buildTableBehavior(makePlain())
    const b = new SelectBuilder<any, any>('plain')
    const before = b.getState().whereTape

    behavior.prepareSelect(b)
    expect(b.getState().whereTape).toBe(before)
  })

  it('adds an IS NULL filter for the soft-delete column', () => {
    const behavior = buildTableBehavior(makeSoft())
    const b = new SelectBuilder<any, any>('soft')

    behavior.prepareSelect(b)
    const { sql } = b.toSQL()

    expect(sql).toContain('"deletedAt" IS NULL')
  })

  it('respects withTrashed() and skips the IS NULL filter', () => {
    const behavior = buildTableBehavior(makeSoft())
    const b = new SelectBuilder<any, any>('soft').withTrashed()
    const before = b.getState().whereTape

    behavior.prepareSelect(b)
    expect(b.getState().whereTape).toBe(before)
    expect(b.toSQL().sql).not.toContain('IS NULL')
  })
})

describe('buildTableBehavior.prepareUpdate', () => {
  it('is a no-op on a plain table', () => {
    const behavior = buildTableBehavior(makePlain())
    const b = new UpdateBuilder<any>('plain').set({ name: 'x' }).where(e => e.eq('id', 1))
    const sqlBefore = b.toSQL().sql

    behavior.prepareUpdate(b, { name: 'x' })
    expect(b.toSQL().sql).toBe(sqlBefore)
  })

  it('appends a version-bump for the optimistic-lock column', () => {
    const behavior = buildTableBehavior(makeOpt())
    const b = new UpdateBuilder<any>('opt').set({ name: 'x' }).where(e => e.eq('id', 1))

    behavior.prepareUpdate(b, { name: 'x' })
    const { sql } = b.toSQL()

    expect(sql).toContain('"version" = "version" + 1')
  })

  it('runs the version bump after .set() so user payloads cannot smuggle a version value', () => {
    const behavior = buildTableBehavior(makeOpt())
    const b = new UpdateBuilder<any>('opt')
      .set({ name: 'x', version: 99 })
      .where(e => e.eq('id', 1))

    behavior.prepareUpdate(b, { name: 'x', version: 99 })
    const { sql } = b.toSQL()

    // The optimistic-lock bump uses setRaw and therefore wins over the user-set value.
    expect(sql).toContain('"version" = "version" + 1')
    expect(sql).not.toContain('"version" = 99')
  })
})

describe('buildTableBehavior.rewriteDelete', () => {
  it('returns null on a plain table', () => {
    const behavior = buildTableBehavior(makePlain())

    expect(behavior.rewriteDelete(e => e.eq('id', 1))).toBeNull()
  })

  it('returns an UpdateBuilder that sets the soft-delete column when the trait is applied', () => {
    const behavior = buildTableBehavior(makeSoft())
    const ub = behavior.rewriteDelete(e => e.eq('id', 1))

    expect(ub).not.toBeNull()
    const { sql } = ub!.toSQL()

    expect(sql).toContain('UPDATE "soft" SET "deletedAt" =')
    expect(sql).toContain('RETURNING')
  })
})

describe('buildTableBehavior.buildRestoreUpdate', () => {
  it('throws when the table has no softDelete trait', () => {
    const behavior = buildTableBehavior(makePlain())

    expect(() => behavior.buildRestoreUpdate({ deletedAt: null }, e => e.eq('id', 1)))
      .toThrow(OrmError)
  })

  it('sets the soft-delete column to NULL and restricts to non-null rows', () => {
    const behavior = buildTableBehavior(makeSoft())
    const b = behavior.buildRestoreUpdate({ deletedAt: null }, e => e.eq('id', 1))
    const { sql, params } = b.toSQL()

    expect(sql).toContain('UPDATE "soft"')
    expect(sql).toContain('"deletedAt" = $1')
    expect(sql).toContain('"deletedAt" IS NOT NULL')
    expect(params[0]).toBeNull()
  })

  it('applies the optimistic-lock bump on a table with both traits', () => {
    const behavior = buildTableBehavior(makeSoftOpt())
    const b = behavior.buildRestoreUpdate({ deletedAt: null }, e => e.eq('id', 1))
    const { sql } = b.toSQL()

    expect(sql).toContain('"version" = "version" + 1')
  })
})
