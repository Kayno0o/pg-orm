import { describe, expect, it } from 'bun:test'
import { UpdateBuilder } from '../../../src/builder/query'

interface Cols { id: any, name: any, age: any }

function update() {
  return new UpdateBuilder<Cols>('users')
}

describe('UpdateBuilder', () => {
  it('generates UPDATE SET', () => {
    const { sql, params } = update()
      .set({ name: 'Bob' } as any)
      .where(e => e.eq('id', 1))
      .toSQL()

    expect(sql).toContain('UPDATE "users" SET "name" = $1')
    expect(sql).toContain('WHERE "id" = $2')
    expect(params).toEqual(['Bob', 1])
  })

  it('returning generates RETURNING *', () => {
    const { sql } = update()
      .set({ name: 'Bob' } as any)
      .where(e => e.eq('id', 1))
      .returning()
      .toSQL()

    expect(sql).toContain('RETURNING *')
  })

  it('returning with specific columns', () => {
    const { sql } = update()
      .set({ name: 'Bob' } as any)
      .where(e => e.eq('id', 1))
      .returning('id', 'name')
      .toSQL()

    expect(sql).toContain('RETURNING "id", "name"')
  })

  it('__raw is handled in assembly (internal use)', () => {
    // Simulate internal optimistic lock usage where __raw is set after validation
    const b = update()

    b._state.setValues = { version: { __raw: '"version" + 1' } }
    b._state.whereTape = null
    const { sql } = b.toSQL()

    expect(sql).toContain('"version" = "version" + 1')
  })

  it('validateValues rejects undefined', () => {
    expect(() => update().set({ name: undefined } as any)).toThrow(/undefined/)
  })

  it('validateValues rejects NaN', () => {
    expect(() => update().set({ age: Number.NaN } as any)).toThrow(/non-finite/)
  })

  it('validateValues rejects __raw in user-facing API', () => {
    expect(() => update().set({ name: { __raw: 'evil' } } as any)).toThrow(/__raw/)
  })

  it('clone produces independent copy', () => {
    const a = update().set({ name: 'Alice' } as any)
    const b = a.clone()

    b.where(e => e.eq('id', 1))

    expect(a._state.whereTape).toBeNull()
  })

  it('without where generates UPDATE without WHERE', () => {
    const { sql } = update().set({ name: 'Bob' } as any).toSQL()

    expect(sql).toBe('UPDATE "users" SET "name" = $1')
  })

  it('multiple SET values', () => {
    const { sql, params } = update()
      .set({ name: 'Bob', age: 30 } as any)
      .toSQL()

    expect(sql).toContain('"name" = $1')
    expect(sql).toContain('"age" = $2')
    expect(params).toEqual(['Bob', 30])
  })
})
