import type { ColumnDef, HasDefault, IsNullable, IsPrimaryKey, NoDefault, NotGenerated, NotNullable, NotPrimaryKey } from '../../../src/types/index'
import { describe, expect, it } from 'bun:test'
import { InsertBuilder } from '../../../src/builder/query'

// eslint-disable-next-line ts/consistent-type-definitions
type Cols = {
  id: ColumnDef<number, NotNullable, HasDefault, IsPrimaryKey, NotGenerated>
  name: ColumnDef<string, NotNullable, NoDefault, NotPrimaryKey, NotGenerated>
  email: ColumnDef<string, NotNullable, NoDefault, NotPrimaryKey, NotGenerated>
  age: ColumnDef<number, IsNullable, NoDefault, NotPrimaryKey, NotGenerated>
}

function insert() {
  return new InsertBuilder<Cols>('users')
}

describe('InsertBuilder', () => {
  it('generates INSERT with values', () => {
    const { sql, params } = insert()
      .values({ name: 'Alice', email: 'alice@test.com' })
      .toSQL()

    expect(sql).toContain('INSERT INTO "users"')
    expect(sql).toContain('"name"')
    expect(sql).toContain('$1')
    expect(params).toContain('Alice')
  })

  it('returning generates RETURNING *', () => {
    const { sql } = insert()
      .values({ name: 'Alice', email: 'a@b.com' })
      .returning()
      .toSQL()

    expect(sql).toContain('RETURNING *')
  })

  it('returning with specific columns', () => {
    const { sql } = insert()
      .values({ name: 'Alice', email: 'a@b.com' })
      .returning('id', 'name')
      .toSQL()

    expect(sql).toContain('RETURNING "id", "name"')
  })

  it('onConflict doNothing', () => {
    const { sql } = insert()
      .values({ name: 'Alice', email: 'a@b.com' })
      .onConflict(['email'])
      .doNothing()
      .toSQL()

    expect(sql).toContain('ON CONFLICT ("email") DO NOTHING')
  })

  it('onConflict doUpdate', () => {
    const { sql } = insert()
      .values({ name: 'Alice', email: 'a@b.com' })
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
      ])
      .toSQL()

    expect(sql).toContain('VALUES')
    expect(params).toHaveLength(4)
  })

  it('many with missing optional columns uses DEFAULT', () => {
    const { sql } = insert()
      .many([
        { name: 'Alice', email: 'a@b.com', age: 30 },
        { name: 'Bob', email: 'b@b.com' },
      ])
      .toSQL()

    expect(sql).toContain('DEFAULT')
  })

  it('validateValues rejects undefined', () => {
    // @ts-expect-error name is required
    expect(() => insert().values({ name: undefined })).toThrow(/undefined/)
  })

  it('validateValues rejects NaN', () => {
    // @ts-expect-error reject invalid values
    expect(() => insert().values({ name: 'ok', age: Number.NaN })).toThrow(/non-finite/)
  })

  it('validateValues rejects Infinity', () => {
    // @ts-expect-error reject invalid values
    expect(() => insert().values({ name: 'ok', age: Infinity })).toThrow(/non-finite/)
  })

  it('validateValues rejects __raw objects', () => {
    // @ts-expect-error reject invalid values
    expect(() => insert().values({ name: { __raw: 'DROP TABLE' } })).toThrow(/__raw/)
  })

  it('validateValues allows null', () => {
    // @ts-expect-error reject invalid values
    expect(() => insert().values({ name: 'ok', age: null })).not.toThrow()
  })

  it('branch produces independent copy', () => {
    const a = insert().values({ name: 'Alice', email: 'a@b.com' })
    const b = a.branch()

    expect(b._state.insertValues).toEqual(a._state.insertValues)
    expect(b._state.insertValues).not.toBe(a._state.insertValues)
  })

  it('explain wraps query', () => {
    const { sql } = insert()
      .values({ name: 'Alice', email: 'a@b.com' })
      .explain()

    expect(sql).toStartWith('EXPLAIN')
  })
})
