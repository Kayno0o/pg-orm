import { describe, expect, it } from 'bun:test'
import { compileWhere, DeleteBuilder, SelectBuilder, UpdateBuilder } from '../../../src/builder/query'
import { ValidationError } from '../../../src/errors/index'

interface Cols {
  id: any
  name: any
  age: any
  status: any
  tags: any
  payload: any
  deletedAt: any
  [key: string]: any
}

function select() {
  return new SelectBuilder<Cols>('users')
}

describe('object where shorthand', () => {
  it('compiles a single column to an equality', () => {
    const { sql, params } = select().where({ id: 1 }).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "id" = $1')
    expect(params).toEqual([1])
  })

  it('ANDs every entry, in declaration order', () => {
    const { sql, params } = select().where({ status: 'active', age: 30 }).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE ("status" = $1 AND "age" = $2)')
    expect(params).toEqual(['active', 30])
  })

  it('maps null to IS NULL', () => {
    const { sql, params } = select().where({ deletedAt: null }).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "deletedAt" IS NULL')
    expect(params).toEqual([])
  })

  it('maps an array to IN', () => {
    const { sql, params } = select().where({ id: [1, 2, 3] }).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "id" IN ($1, $2, $3)')
    expect(params).toEqual([1, 2, 3])
  })

  it('maps an empty array to FALSE rather than invalid SQL', () => {
    expect(select().where({ id: [] }).toSQL().sql).toBe('SELECT * FROM "users" WHERE FALSE')
  })

  it('parameterizes values instead of interpolating them', () => {
    const { sql, params } = select().where({ name: '\'; DROP TABLE users; --' }).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "name" = $1')
    expect(params).toEqual(['\'; DROP TABLE users; --'])
  })

  it('escapes a quote in a column name rather than breaking out of the identifier', () => {
    const { sql } = select().where({ 'na"me': 1 }).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "na""me" = $1')
  })

  it('works on update and delete builders', () => {
    const update = new UpdateBuilder<Cols>('users').set({ name: 'Bob' }).where({ id: 7 }).toSQL()

    expect(update.sql).toBe('UPDATE "users" SET "name" = $1 WHERE "id" = $2')
    expect(update.params).toEqual(['Bob', 7])

    const del = new DeleteBuilder<Cols>('users').where({ id: 7 }).toSQL()

    expect(del.sql).toBe('DELETE FROM "users" WHERE "id" = $1')
  })

  it('mixes with the callback form through andWhere', () => {
    const { sql, params } = select()
      .where({ status: 'active' })
      .andWhere(e => e.gt('age', 18))
      .toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE ("status" = $1 AND "age" > $2)')
    expect(params).toEqual(['active', 18])
  })

  it('supports the inline `value && { … }` shape', () => {
    const status: string | undefined = undefined
    const name = 'Alice'
    const { sql, params } = select()
      .andWhere(status && { status })
      .andWhere(name && { name })
      .toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "name" = $1')
    expect(params).toEqual(['Alice'])
  })

  it('drives HAVING too', () => {
    const { sql, params } = select().groupBy('status').having({ status: 'active' }).toSQL()

    expect(sql).toContain('HAVING "status" = $1')
    expect(params).toEqual(['active'])
  })
})

describe('object where operators', () => {
  it('supports the comparison operators', () => {
    const { sql, params } = select().where({ age: { gte: 18, lt: 65 } }).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE ("age" >= $1 AND "age" < $2)')
    expect(params).toEqual([18, 65])
  })

  it('supports in, notIn and between', () => {
    expect(select().where({ id: { notIn: [1, 2] } }).toSQL().sql).toBe('SELECT * FROM "users" WHERE "id" NOT IN ($1, $2)')
    expect(select().where({ age: { between: [10, 20] } }).toSQL().sql).toBe('SELECT * FROM "users" WHERE "age" BETWEEN $1 AND $2')
  })

  it('escapes LIKE metacharacters in contains/startsWith/endsWith', () => {
    const { sql, params } = select().where({ name: { contains: '100%' } }).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "name" LIKE $1')
    expect(params).toEqual(['%100\\%%'])
  })

  it('maps isNull both ways', () => {
    expect(select().where({ deletedAt: { isNull: true } }).toSQL().sql).toBe('SELECT * FROM "users" WHERE "deletedAt" IS NULL')
    expect(select().where({ deletedAt: { isNull: false } }).toSQL().sql).toBe('SELECT * FROM "users" WHERE "deletedAt" IS NOT NULL')
  })

  it('reads eq: null and neq: null as null checks', () => {
    expect(select().where({ deletedAt: { eq: null } }).toSQL().sql).toBe('SELECT * FROM "users" WHERE "deletedAt" IS NULL')
    expect(select().where({ deletedAt: { neq: null } }).toSQL().sql).toBe('SELECT * FROM "users" WHERE "deletedAt" IS NOT NULL')
  })

  it('takes an array value on an array column through eq', () => {
    const { sql, params } = select().where({ tags: { eq: ['a', 'b'] } }).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "tags" = $1')
    expect(params).toEqual([['a', 'b']])
  })

  it('treats a plain object with no operator keys as a json value', () => {
    const { sql, params } = select().where({ payload: { theme: 'dark' } }).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "payload" = $1')
    expect(params).toEqual([{ theme: 'dark' }])
  })
})

describe('object where rejections', () => {
  it('rejects undefined rather than silently matching every row', () => {
    expect(() => select().where({ id: undefined as any }).toSQL()).toThrow(ValidationError)
  })

  it('rejects an empty object', () => {
    expect(() => select().where({}).toSQL()).toThrow(ValidationError)
  })

  it('rejects an object mixing operators with plain keys', () => {
    expect(() => select().where({ payload: { eq: 1, theme: 'dark' } as any }).toSQL()).toThrow(ValidationError)
  })

  it('rejects a non-array value for in', () => {
    expect(() => select().where({ id: { in: 1 as any } }).toSQL()).toThrow(ValidationError)
  })

  it('rejects a between range that is not a pair', () => {
    expect(() => select().where({ age: { between: [1] as any } }).toSQL()).toThrow(ValidationError)
  })

  it('rejects undefined as an operator value', () => {
    expect(() => select().where({ age: { gte: undefined } }).toSQL()).toThrow(ValidationError)
  })
})

describe('compileWhere', () => {
  it('compiles both forms to a tape callers can compose', () => {
    const { sql, params } = select()
      .where(e => e.or(compileWhere<Cols>({ status: 'active' }), compileWhere<Cols>(x => x.eq('id', 1))))
      .toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE ("status" = $1 OR "id" = $2)')
    expect(params).toEqual(['active', 1])
  })
})
