import { describe, expect, it } from 'bun:test'
import { BulkUpdateBuilder } from '../../../src/builder/bulk-update'
import { InsertBuilder, MergeBuilder, SelectBuilder, SetOperationBuilder } from '../../../src/builder/query'
import { ValidationError } from '../../../src/errors/index'
import { defineTable } from '../../../src/index'

const items = defineTable('bs_items', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
}))

describe('MERGE', () => {
  const merge = () => new MergeBuilder<any>('t').using('s', 's').on(e => e.eq('id', e.ref('s.id')))

  it('refuses a statement with no WHEN clause', () => {
    expect(() => merge().toSQL()).toThrow(ValidationError)
    expect(merge().whenMatchedDelete().toSQL().sql).toContain('WHEN MATCHED THEN DELETE')
  })

  it('refuses an update or an insert that sets no column', () => {
    expect(() => merge().whenMatched('update', {})).toThrow(ValidationError)
    expect(() => merge().whenNotMatched('insert', {})).toThrow(ValidationError)
    expect(() => merge().whenNotMatchedBySource('update', {})).toThrow(ValidationError)
  })
})

describe('pick() of a qualified column', () => {
  it('refuses an alias the statement does not declare', () => {
    expect(() => new SelectBuilder<any>(items).pick('zz.id').toSQL()).toThrow(ValidationError)
    expect(new SelectBuilder<any>(items).as('i').pick('i.id').toSQL().sql).toBe('SELECT "i"."id" AS "i.id" FROM "bs_items" AS "i"')
  })
})

describe('distinct() with distinctOn()', () => {
  it('refuses both on one query', () => {
    expect(() => new SelectBuilder<any>(items).distinct().distinctOn('name').toSQL()).toThrow(ValidationError)
  })
})

describe('a column named like an Object.prototype member', () => {
  it('is copied by an upsert that updates the incoming columns', () => {
    const { sql } = new InsertBuilder<any>('t').values({ id: 1, constructor: 2, toString: 3 }).onConflict(['id']).doUpdate().toSQL()

    expect(sql).toEndWith('DO UPDATE SET "constructor" = EXCLUDED."constructor", "toString" = EXCLUDED."toString"')
  })

  it('is written by a bulk update, and keeps its value on a row that does not set it', () => {
    const table = defineTable('bs_proto', t => ({ id: t.int4().primaryKey(), constructor: t.int4(), name: t.text() }))
    const { sql, params } = new BulkUpdateBuilder('bs_proto', table.columns, ['id'], [
      { key: { id: 1 }, set: { constructor: 5 } },
      { key: { id: 2 }, set: { name: 'x' } },
    ]).toSQL()

    expect(params.every(p => typeof p !== 'function')).toBe(true)
    expect(sql).toContain('"constructor" = CASE WHEN')
  })
})

describe('a set operation on SQLite', () => {
  it('leaves operands bare, so a recursive CTE may read itself, and wraps one with its own ORDER BY or LIMIT', () => {
    const base = new SelectBuilder<any>('n').pick('id')
    const step = new SelectBuilder<any>('n').as('c').pick('c.id').join('tree', 't', e => e.eq('c.parent', e.ref('t.id')))

    expect(SetOperationBuilder.unionAll(base, step).toSQL('sqlite').sql).not.toContain('SELECT * FROM (')
    expect(SetOperationBuilder.unionAll(base, base.branch().limit(1)).toSQL('sqlite').sql).toContain('SELECT * FROM (SELECT "id" FROM "n" LIMIT')
  })
})
