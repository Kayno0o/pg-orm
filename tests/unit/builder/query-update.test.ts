import { describe, expect, it } from 'bun:test'
import { rawSql, UpdateBuilder } from '../../../src/builder/query'

interface Cols { id: any, name: any, age: any, [key: string]: any }

function update() {
  return new UpdateBuilder<Cols>('users')
}

describe('UpdateBuilder', () => {
  it('generates UPDATE SET', () => {
    const { sql, params } = update()
      .set({ name: 'Bob' })
      .where(e => e.eq('id', 1))
      .toSQL()

    expect(sql).toContain('UPDATE "users" SET "name" = $1')
    expect(sql).toContain('WHERE "id" = $2')
    expect(params).toEqual(['Bob', 1])
  })

  it('returning generates RETURNING *', () => {
    const { sql } = update()
      .set({ name: 'Bob' })
      .where(e => e.eq('id', 1))
      .returning()
      .toSQL()

    expect(sql).toContain('RETURNING *')
  })

  it('returning with specific columns', () => {
    const { sql } = update()
      .set({ name: 'Bob' })
      .where(e => e.eq('id', 1))
      .returning('id', 'name')
      .toSQL()

    expect(sql).toContain('RETURNING "id", "name"')
  })

  it('branded rawSql is handled in assembly (internal use)', () => {
    // Simulate internal optimistic lock usage where rawSql() is set after validation
    const b = update()

    b._state.setValues = { version: rawSql('"version" + 1') }
    b._state.whereTape = null
    const { sql } = b.toSQL()

    expect(sql).toContain('"version" = "version" + 1')
  })

  it('unbranded {__raw} object is treated as a regular value (not raw SQL)', () => {
    // Security: structurally-shaped objects that skip the brand check must NOT
    // be interpolated. They get parameterized like any other value.
    const b = update()

    b._state.setValues = { name: { __raw: 'evil' } as never }
    b._state.whereTape = null
    const { sql, params } = b.toSQL()

    expect(sql).not.toContain('evil')
    expect(sql).toContain('"name" = $1')
    expect(params[0]).toEqual({ __raw: 'evil' })
  })

  it('validateValues rejects undefined', () => {
    expect(() => update().set({ name: undefined })).toThrow(/undefined/)
  })

  it('validateValues rejects NaN', () => {
    expect(() => update().set({ age: Number.NaN })).toThrow(/non-finite/)
  })

  it('validateValues rejects __raw in user-facing API', () => {
    expect(() => update().set({ name: { __raw: 'evil' } })).toThrow(/__raw/)
  })

  it('branch produces independent copy', () => {
    const a = update().set({ name: 'Alice' })
    const b = a.branch()

    b.where(e => e.eq('id', 1))

    expect(a._state.whereTape).toBeNull()
  })

  it('without where generates UPDATE without WHERE', () => {
    const { sql } = update().set({ name: 'Bob' }).toSQL()

    expect(sql).toBe('UPDATE "users" SET "name" = $1')
  })

  it('rejects an empty SET instead of emitting "SET WHERE"', () => {
    expect(() => update().set({}).where(e => e.eq('id', 1)).toSQL()).toThrow(/no columns to set/)
    expect(() => update().toSQL()).toThrow(/no columns to set/)
  })

  it('multiple SET values', () => {
    const { sql, params } = update()
      .set({ name: 'Bob', age: 30 })
      .toSQL()

    expect(sql).toContain('"name" = $1')
    expect(sql).toContain('"age" = $2')
    expect(params).toEqual(['Bob', 30])
  })
})
