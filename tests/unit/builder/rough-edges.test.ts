import { describe, expect, it } from 'bun:test'
import { InsertBuilder, SelectBuilder, UpdateBuilder } from '../../../src/builder/query'
import { DialectError, ValidationError } from '../../../src/errors/index'
import { compileWhere, defineTable } from '../../../src/index'

const items = defineTable('re_items', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
  prefs: t.jsonb<{ theme: string }>(),
  version: t.int4(),
}))

type Cols = typeof items.columns

const select = () => new SelectBuilder<Cols>(items)

describe('an object WHERE value naming no operator', () => {
  it('throws on a column that is not json, a typo\'d operator then failing loudly', () => {
    expect(() => select().where({ id: { gtt: 1 } } as never).toSQL()).toThrow(ValidationError)
    expect(() => select().andWhere({ name: {} } as never).toSQL()).toThrow(ValidationError)
    expect(() => compileWhere({ id: { gtt: 1 } } as never, items.columns)).toThrow(ValidationError)
  })

  it('still compares a json column for equality', () => {
    expect(select().where({ prefs: { theme: 'dark' } }).toSQL().params).toEqual([{ theme: 'dark' }])
  })
})

describe('an undefined operand', () => {
  it('throws in the callback form as in the object form', () => {
    expect(() => select().where(e => e.eq('name', undefined as never)).toSQL()).toThrow(ValidationError)
    expect(() => select().where(e => e.between('id', 1, undefined as never)).toSQL()).toThrow(ValidationError)
    expect(() => select().where(e => e.in('id', undefined as never)).toSQL()).toThrow(ValidationError)
    expect(() => select().where({ name: { eq: undefined } }).toSQL()).toThrow(ValidationError)
  })
})

describe('a like-family pattern', () => {
  it('must be a string in either form', () => {
    expect(() => select().where({ name: { like: 5 as never } }).toSQL()).toThrow(ValidationError)
    expect(() => select().where({ name: { contains: 5 as never } }).toSQL()).toThrow(ValidationError)
    expect(() => select().where(e => e.ilike('name', null as never)).toSQL()).toThrow(ValidationError)
  })
})

describe('the Postgres JSON and array aggregates', () => {
  it('throw DialectError on SQLite', () => {
    expect(() => select().computed(e => e.jsonAgg('name'), 'names').toSQL('sqlite')).toThrow(DialectError)
    expect(() => select().computed(e => e.jsonbAgg('name'), 'names').toSQL('sqlite')).toThrow(DialectError)
    expect(() => select().aggregate(e => ({ names: e.arrayAgg('name') })).toSQL('sqlite')).toThrow(DialectError)
    expect(select().computed(e => e.jsonAgg('name'), 'names').toSQL().sql).toContain('json_agg("name")')
  })
})

describe('builders', () => {
  it('fork with branch(), the base keeping its own clauses', () => {
    const base = select().where({ name: 'a' })
    const forked = base.branch().andWhere({ id: 1 })

    expect(base.toSQL().params).toEqual(['a'])
    expect(forked.toSQL().params).toEqual(['a', 1])
  })

  it('copy what values(), many() and set() are given', () => {
    const set = { name: 'b' }
    const row = { name: 'a', prefs: { theme: 'x' }, version: 1 }
    const insert = new InsertBuilder<Cols>(items).values(row)

    new UpdateBuilder<Cols>(items).set(set).setRaw('version', '"version" + 1').where({ id: 1 }).toSQL()
    row.name = 'changed'

    expect(set).toEqual({ name: 'b' })
    expect(insert.toSQL().params[0]).toBe('a')
  })

  it('refuse an insert with no row', () => {
    expect(() => new InsertBuilder<Cols>(items).toSQL()).toThrow(ValidationError)
    expect(() => new InsertBuilder<Cols>(items).onConflict(['name']).doUpdate().toSQL()).toThrow(ValidationError)
  })
})
