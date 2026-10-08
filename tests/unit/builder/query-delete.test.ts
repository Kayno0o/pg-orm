import { describe, expect, it } from 'bun:test'
import { DeleteBuilder } from '../../../src/builder/query'
import { ValidationError } from '../../../src/errors/index'

interface Cols { id: any, name: any, [key: string]: any }

function del() {
  return new DeleteBuilder<Cols>('users')
}

describe('DeleteBuilder', () => {
  it('generates DELETE FROM', () => {
    const { sql } = del().where(e => e.eq('id', 1)).toSQL()

    expect(sql).toBe('DELETE FROM "users" WHERE "id" = $1')
  })

  it('returning generates RETURNING *', () => {
    const { sql } = del().where(e => e.eq('id', 1)).returning().toSQL()

    expect(sql).toContain('RETURNING *')
  })

  it('returning with specific columns', () => {
    const { sql } = del().where(e => e.eq('id', 1)).returning('id').toSQL()

    expect(sql).toContain('RETURNING "id"')
  })

  it('without where throws', () => {
    expect(() => del().toSQL()).toThrow(ValidationError)
  })

  it('throws when every condition came out falsy', () => {
    expect(() => del().where(undefined).andWhere(false).toSQL()).toThrow(/allRows\(\)/)
  })

  it('allRows() generates DELETE without WHERE', () => {
    const { sql } = del().allRows().toSQL()

    expect(sql).toBe('DELETE FROM "users"')
  })

  it('branch produces independent copy', () => {
    const a = del().where(e => e.eq('id', 1))
    const b = a.branch()

    expect(b._state.whereTape).not.toBe(a._state.whereTape)
  })

  it('explain wraps query', () => {
    const { sql } = del().where(e => e.eq('id', 1)).explain()

    expect(sql).toStartWith('EXPLAIN')
  })
})
