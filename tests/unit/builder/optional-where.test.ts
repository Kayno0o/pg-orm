import { describe, expect, it } from 'bun:test'
import { DeleteBuilder, SelectBuilder, UpdateBuilder } from '../../../src/builder/query'

interface Cols {
  id: any
  name: any
  age: any
  status: any
  [key: string]: any
}

function select() {
  return new SelectBuilder<Cols>('users')
}

describe('optional where conditions', () => {
  it('treats a falsy where() as a no-op', () => {
    for (const falsy of [undefined, null, false, '', 0] as const)
      expect(select().where(falsy).toSQL().sql).toBe('SELECT * FROM "users"')
  })

  it('keeps the existing clause when where() is falsy', () => {
    const { sql, params } = select()
      .where(e => e.eq('id', 1))
      .where(undefined)
      .toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "id" = $1')
    expect(params).toEqual([1])
  })

  it('treats a falsy andWhere() as a no-op', () => {
    const { sql, params } = select()
      .where(e => e.eq('id', 1))
      .andWhere(undefined)
      .andWhere(false)
      .toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "id" = $1')
    expect(params).toEqual([1])
  })

  it('supports the inline `value && (e => ...)` shape', () => {
    const status: string | undefined = undefined
    const name = 'Alice'
    const { sql, params } = select()
      .andWhere(status && (e => e.eq('status', status)))
      .andWhere(name && (e => e.eq('name', name)))
      .toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "name" = $1')
    expect(params).toEqual(['Alice'])
  })
})

describe('whereAll', () => {
  it('ANDs every truthy condition in one clause', () => {
    const { sql, params } = select()
      .whereAll(
        e => e.eq('name', 'Alice'),
        false,
        e => e.gt('age', 18),
        undefined,
        e => e.eq('status', 'active'),
      )
      .toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE ("name" = $1 AND "age" > $2 AND "status" = $3)')
    expect(params).toEqual(['Alice', 18, 'active'])
  })

  it('is a no-op when every condition is falsy', () => {
    expect(select().whereAll(false, undefined, null).toSQL().sql).toBe('SELECT * FROM "users"')
  })

  it('emits a bare clause for a single truthy condition', () => {
    expect(select().whereAll(false, e => e.eq('id', 1)).toSQL().sql)
      .toBe('SELECT * FROM "users" WHERE "id" = $1')
  })

  it('ANDs onto an existing where()', () => {
    const { sql } = select()
      .where(e => e.eq('id', 1))
      .whereAll(e => e.eq('status', 'active'))
      .toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE ("id" = $1 AND "status" = $2)')
  })

  it('matches repeated andWhere calls', () => {
    const all = select().whereAll(e => e.eq('id', 1), e => e.eq('name', 'A')).toSQL()
    const chained = select().andWhere(e => e.eq('id', 1)).andWhere(e => e.eq('name', 'A')).toSQL()

    expect(all.sql).toBe(chained.sql)
    expect(all.params).toEqual(chained.params)
  })
})

describe('mutation builders', () => {
  it('accept optional conditions on update', () => {
    const { sql, params } = new UpdateBuilder<Cols>('users')
      .set({ name: 'Bob' })
      .where(undefined)
      .whereAll(e => e.eq('id', 1), false)
      .toSQL()

    expect(sql).toBe('UPDATE "users" SET "name" = $1 WHERE "id" = $2')
    expect(params).toEqual(['Bob', 1])
  })

  it('accept optional conditions on delete', () => {
    const { sql } = new DeleteBuilder<Cols>('users')
      .where(e => e.eq('id', 1))
      .andWhere(false)
      .toSQL()

    expect(sql).toBe('DELETE FROM "users" WHERE "id" = $1')
  })
})
