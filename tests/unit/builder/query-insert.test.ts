import { describe, expect, it } from 'bun:test'
import { InsertBuilder } from '../../../src/builder/query'

interface Cols { id: any, name: any, email: any, age: any, [key: string]: any }

function insert() {
  return new InsertBuilder<Cols>('users')
}

describe('InsertBuilder', () => {
  it('generates INSERT with values', () => {
    const { sql, params } = insert()
      .values({ name: 'Alice', email: 'alice@test.com' } as any)
      .toSQL()

    expect(sql).toContain('INSERT INTO "users"')
    expect(sql).toContain('"name"')
    expect(sql).toContain('$1')
    expect(params).toContain('Alice')
  })

  it('returning generates RETURNING *', () => {
    const { sql } = insert()
      .values({ name: 'Alice', email: 'a@b.com' } as any)
      .returning()
      .toSQL()

    expect(sql).toContain('RETURNING *')
  })

  it('returning with specific columns', () => {
    const { sql } = insert()
      .values({ name: 'Alice', email: 'a@b.com' } as any)
      .returning('id', 'name')
      .toSQL()

    expect(sql).toContain('RETURNING "id", "name"')
  })

  it('onConflict doNothing', () => {
    const { sql } = insert()
      .values({ name: 'Alice', email: 'a@b.com' } as any)
      .onConflict(['email'])
      .doNothing()
      .toSQL()

    expect(sql).toContain('ON CONFLICT ("email") DO NOTHING')
  })

  it('onConflict doUpdate', () => {
    const { sql } = insert()
      .values({ name: 'Alice', email: 'a@b.com' } as any)
      .onConflict(['email'])
      .doUpdate('name')
      .toSQL()

    expect(sql).toContain('ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name"')
  })

  it('many generates batch INSERT', () => {
    const { sql, params } = insert()
      .many([
        { name: 'Alice', email: 'a@b.com' },
        { name: 'Bob', email: 'b@b.com' },
      ] as any)
      .toSQL()

    expect(sql).toContain('VALUES')
    expect(params).toHaveLength(4)
  })

  it('many with missing optional columns uses DEFAULT', () => {
    const { sql } = insert()
      .many([
        { name: 'Alice', email: 'a@b.com', age: 30 },
        { name: 'Bob', email: 'b@b.com' },
      ] as any)
      .toSQL()

    expect(sql).toContain('DEFAULT')
  })

  it('validateValues rejects undefined', () => {
    expect(() => insert().values({ name: undefined } as any)).toThrow(/undefined/)
  })

  it('validateValues rejects NaN', () => {
    expect(() => insert().values({ name: 'ok', age: Number.NaN } as any)).toThrow(/non-finite/)
  })

  it('validateValues rejects Infinity', () => {
    expect(() => insert().values({ name: 'ok', age: Infinity } as any)).toThrow(/non-finite/)
  })

  it('validateValues rejects __raw objects', () => {
    expect(() => insert().values({ name: { __raw: 'DROP TABLE' } } as any)).toThrow(/__raw/)
  })

  it('validateValues allows null', () => {
    expect(() => insert().values({ name: 'ok', age: null } as any)).not.toThrow()
  })

  it('clone produces independent copy', () => {
    const a = insert().values({ name: 'Alice', email: 'a@b.com' } as any)
    const b = a.clone()

    expect(b._state.insertValues).toEqual(a._state.insertValues)
    expect(b._state.insertValues).not.toBe(a._state.insertValues)
  })

  it('explain wraps query', () => {
    const { sql } = insert()
      .values({ name: 'Alice', email: 'a@b.com' } as any)
      .explain()

    expect(sql).toStartWith('EXPLAIN')
  })
})
