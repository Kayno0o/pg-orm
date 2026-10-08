import { describe, expect, it } from 'bun:test'
import { SelectBuilder, SetOperationBuilder } from '../../../src/builder/query'
import { DialectError } from '../../../src/errors/index'

interface Cols { id: any, name: any, tags: any, data: any, [key: string]: any }

function select() {
  return new SelectBuilder<Cols>('users')
}

describe('SQL for SQLite', () => {
  it('turns a case-sensitive like into a GLOB, its wildcards translated and its own escaped', () => {
    const { sql, params } = select().where(e => e.like('name', 'A%_*\\%')).toSQL('sqlite')

    expect(sql).toBe('SELECT * FROM "users" WHERE "name" GLOB $1')
    expect(params).toEqual(['A*?[*]%'])
  })

  it('turns ilike into a LIKE escaping with a backslash', () => {
    expect(select().where(e => e.ilike('name', 'a%')).toSQL('sqlite').sql).toBe('SELECT * FROM "users" WHERE "name" LIKE $1 ESCAPE \'\\\'')
  })

  it('gives an OFFSET without a LIMIT the LIMIT SQLite requires', () => {
    expect(select().offset(5).toSQL('sqlite').sql).toBe('SELECT * FROM "users" LIMIT -1 OFFSET $1')
  })

  it('names the count, which SQLite would call count(*)', () => {
    expect(select().count().toSQL('sqlite').sql).toBe('SELECT count(*) AS "count" FROM "users"')
  })

  it('reads an array column as JSON', () => {
    expect(select().where(e => e.arrayContains('tags', 'a')).toSQL('sqlite').sql).toBe('SELECT * FROM "users" WHERE EXISTS (SELECT 1 FROM json_each("tags") WHERE "value" = $1)')
    expect(select().where(e => e.arrayOverlap('tags', ['a', 'b'])).toSQL('sqlite').sql).toBe('SELECT * FROM "users" WHERE EXISTS (SELECT 1 FROM json_each("tags") WHERE "value" IN ($1, $2))')
    expect(select().where(e => e.arrayOverlap('tags', [])).toSQL('sqlite').sql).toBe('SELECT * FROM "users" WHERE FALSE')
  })

  it('drops row locks, SQLite locking the whole database for a write', () => {
    expect(select().forUpdate().toSQL('sqlite').sql).toBe('SELECT * FROM "users"')
  })

  it('wraps each operand of a set operation, its params numbered in order', () => {
    const { sql, params } = SetOperationBuilder.union(select().where(e => e.eq('id', 1)), select().where(e => e.eq('id', 2))).limit(3).offset(1).toSQL('sqlite')

    expect(sql).toBe('SELECT * FROM (SELECT * FROM "users" WHERE "id" = $1) UNION SELECT * FROM (SELECT * FROM "users" WHERE "id" = $2) LIMIT $3 OFFSET $4')
    expect(params).toEqual([1, 2, 3, 1])
  })

  it('explains with EXPLAIN QUERY PLAN', () => {
    expect(select().explain({}, 'sqlite').sql).toBe('EXPLAIN QUERY PLAN SELECT * FROM "users"')
  })

  it('throws DialectError for what only Postgres has', () => {
    expect(() => select().where(e => e.jsonbPath('data', '$.a')).toSQL('sqlite')).toThrow(DialectError)
    expect(() => select().distinctOn('name').toSQL('sqlite')).toThrow(DialectError)
    expect(() => select().explain({ analyze: true }, 'sqlite')).toThrow(DialectError)
  })

  it('leaves the Postgres SQL as it was', () => {
    expect(select().where(e => e.like('name', 'A%')).offset(5).toSQL().sql).toBe('SELECT * FROM "users" WHERE "name" LIKE $1 OFFSET $2')
  })
})
