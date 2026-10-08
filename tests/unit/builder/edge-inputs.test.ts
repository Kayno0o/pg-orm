import { describe, expect, it } from 'bun:test'
import { InsertBuilder, MergeBuilder, SelectBuilder, SetOperationBuilder, UpsertBuilder } from '../../../src/builder/query'
import { ValidationError } from '../../../src/errors/index'

const select = () => new SelectBuilder<any>('t')

describe('builders on edge inputs', () => {
  it('a grouped count wraps a query listing its group columns, not *', () => {
    expect(select().groupBy('s').count().toSQL().sql).toBe('SELECT count(*) FROM ( SELECT "s" FROM "t" GROUP BY "s" ) AS "__counted"')
  })

  it('an insert-many upsert copies every row\'s columns, and refuses rows leaving out different ones', () => {
    expect(new InsertBuilder<any>('t').many([{ a: 1, b: 2 }, { a: 2, b: 3 }]).onConflict(['a']).doUpdate().toSQL().sql).toContain('DO UPDATE SET "b" = EXCLUDED."b"')
    expect(() => new InsertBuilder<any>('t').many([{ a: 1 }, { a: 2, b: 3 }]).onConflict(['a']).doUpdate().toSQL()).toThrow(ValidationError)
  })

  it('an empty and() holds and an empty or() does not', () => {
    expect(select().where(e => e.and()).toSQL().sql).toBe('SELECT * FROM "t" WHERE TRUE')
    expect(select().where(e => e.or()).toSQL().sql).toBe('SELECT * FROM "t" WHERE FALSE')
  })

  it('arrayOverlap with no values matches nothing on Postgres', () => {
    expect(select().where(e => e.arrayOverlap('x', [])).toSQL().sql).toBe('SELECT * FROM "t" WHERE FALSE')
  })

  it('many() refuses no rows, writes one empty row as DEFAULT VALUES and refuses several', () => {
    expect(() => new InsertBuilder<any>('t').many([]).toSQL()).toThrow(ValidationError)
    expect(new InsertBuilder<any>('t').many([{}]).toSQL().sql).toBe('INSERT INTO "t" DEFAULT VALUES')
    expect(() => new InsertBuilder<any>('t').many([{}, {}]).toSQL()).toThrow(ValidationError)
  })

  it('a set operation with no query throws a ValidationError', () => {
    expect(() => SetOperationBuilder.union()).toThrow(ValidationError)
  })

  it('an UpsertBuilder writing only its conflict keys sets the target to itself', () => {
    expect(new UpsertBuilder<any>('t').values({ a: 1 }).onConflict('a').toSQL().sql).toEndWith('ON CONFLICT ("a") DO UPDATE SET "a" = EXCLUDED."a"')
  })

  it('MERGE without using() and on() throws a ValidationError', () => {
    expect(() => new MergeBuilder<any>('t').toSQL()).toThrow(ValidationError)
  })

  it('skipLocked() without a lock throws a ValidationError', () => {
    expect(() => select().skipLocked().toSQL()).toThrow(ValidationError)
    expect(select().forUpdate().skipLocked().toSQL().sql).toEndWith('FOR UPDATE SKIP LOCKED')
  })

  it('a set operation embedded as a subquery keeps its dialect and numbers its params after the outer ones', () => {
    const union = SetOperationBuilder.union(select().pick('id').limit(5), select().pick('id')).limit(6)
    const { sql, params } = select().where(e => e.and(e.eq('a', 1), e.exists(union))).toSQL('sqlite')

    expect(sql).toContain('SELECT * FROM (SELECT "id" FROM "t" LIMIT $2) UNION')
    expect(sql).toContain('LIMIT $3))')
    expect(params).toEqual([1, 5, 6])
  })

  it('renumbering leaves a $N inside a string literal alone', () => {
    const { sql, params } = select().with('c', 'SELECT 1 AS x WHERE $1 = 1', [5]).with('d', 'SELECT \'$1\' AS x, $1 AS y', [7]).toSQL()

    expect(sql).toContain('"d" AS (SELECT \'$1\' AS x, $2 AS y)')
    expect(params).toEqual([5, 7])
  })

  it('e.raw() takes ?? as a literal ? and leaves a ? inside a literal alone', () => {
    const { sql, params } = select().where(e => e.raw('"j" ?? ? AND "k" = \'what?\'', 'k')).toSQL()

    expect(sql).toBe('SELECT * FROM "t" WHERE "j" ? $1 AND "k" = \'what?\'')
    expect(params).toEqual(['k'])
    expect(() => select().where(e => e.raw('"k" = ?', 1, 2)).toSQL()).toThrow('fewer "?" placeholders than parameters')
  })

  it('jsonbSubscript says whether each step is a key or an index on Postgres', () => {
    expect(select().where(e => e.isNull(e.jsonbSubscript('j', 'a', 0))).toSQL().sql).toContain('(("j" -> $1::text) -> $2::int)')
    expect(select().where(e => e.isNull(e.jsonbSubscript('j', 'a', 0))).toSQL('sqlite').sql).toContain('(("j" -> $1) -> $2)')
  })
})
