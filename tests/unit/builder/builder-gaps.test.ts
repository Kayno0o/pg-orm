import { describe, expect, it } from 'bun:test'
import { DeleteBuilder, InsertBuilder, SelectBuilder, UpdateBuilder, UpsertBuilder } from '../../../src/builder/query'
import { DialectError, ValidationError } from '../../../src/errors/index'

const select = () => new SelectBuilder<any>('t')
const where = (fn: Parameters<SelectBuilder<any>['where']>[0]) => select().where(fn).toSQL()

describe('expressions the builder used to leave to raw SQL', () => {
  it('IS [NOT] DISTINCT FROM, NOT LIKE and NOT ILIKE', () => {
    expect(where(e => e.isDistinctFrom('a', null))).toEqual({ sql: 'SELECT * FROM "t" WHERE "a" IS DISTINCT FROM $1', params: [null] })
    expect(where(e => e.isNotDistinctFrom('a', 1)).sql).toBe('SELECT * FROM "t" WHERE "a" IS NOT DISTINCT FROM $1')
    expect(where(e => e.notLike('a', 'x%')).sql).toBe('SELECT * FROM "t" WHERE NOT ("a" LIKE $1)')
    expect(where(e => e.notIlike('a', 'x%')).sql).toBe('SELECT * FROM "t" WHERE NOT ("a" ILIKE $1)')
  })

  it('BETWEEN takes a column reference or an expression for either bound', () => {
    expect(where(e => e.between('x', e.ref('u.lo'), e.coalesce('hi', 9)))).toEqual({ sql: 'SELECT * FROM "t" WHERE "x" BETWEEN "u"."lo" AND COALESCE("hi", $1)', params: [9] })
  })

  it('jsonb @> binds its value as JSON, on Postgres only', () => {
    expect(where(e => e.jsonbContains('meta', { tag: 'a' }))).toEqual({ sql: 'SELECT * FROM "t" WHERE "meta" @> $1::text::jsonb', params: ['{"tag":"a"}'] })
    expect(() => select().where(e => e.jsonbContains('meta', {})).toSQL('sqlite')).toThrow(DialectError)
  })

  it('IN and NOT IN a subquery builder, numbering its placeholders after the outer ones', () => {
    const sub = new SelectBuilder<any>('u').pick('id').where({ role: 'admin' })

    expect(where(e => e.and(e.eq('x', 1), e.inSubquery('owner', sub)))).toEqual({ sql: 'SELECT * FROM "t" WHERE ("x" = $1 AND "owner" IN (SELECT "id" FROM "u" WHERE "role" = $2))', params: [1, 'admin'] })
    expect(where(e => e.notInSubquery(['a', 'b'], sub)).sql).toBe('SELECT * FROM "t" WHERE ("a", "b") NOT IN (SELECT "id" FROM "u" WHERE "role" = $1)')
  })

  it('coalesce and CASE stand where a value goes and in a computed column', () => {
    expect(where(e => e.eq(e.coalesce('a', 0), 3)).sql).toBe('SELECT * FROM "t" WHERE COALESCE("a", $1) = $2')

    const q = select().computed(e => e.caseWhen([[e.gt('n', 10), 'big'], [e.gt('n', 0), 'small']], 'none'), 'size').toSQL()

    expect(q).toEqual({ sql: 'SELECT *, (CASE WHEN "n" > $1 THEN $2 WHEN "n" > $3 THEN $4 ELSE $5 END) AS "size" FROM "t"', params: [10, 'big', 0, 'small', 'none'] })
  })

  it('countDistinct and window functions over a declared window, cast to read back as numbers', () => {
    const q = select()
      .window('w', { partitionBy: ['g'], orderBy: [{ col: 'n', dir: 'desc' }] })
      .computed(e => e.over(e.rowNumber(), 'w'), 'pos')
      .computed(e => e.over(e.sum('n'), 'w'), 'running')
      .computed(e => e.over(e.max('n'), 'w'), 'top')
      .toSQL()

    expect(q.sql).toBe('SELECT *, CAST(ROW_NUMBER() OVER "w" AS double precision) AS "pos", CAST(SUM("n") OVER "w" AS double precision) AS "running", MAX("n") OVER "w" AS "top" FROM "t" WINDOW "w" AS (PARTITION BY "g" ORDER BY "n" DESC)')
    expect(select().computed(e => e.countDistinct('a'), 'n').toSQL().sql).toBe('SELECT *, CAST(COUNT(DISTINCT "a") AS double precision) AS "n" FROM "t"')
    expect(() => select().computed(e => e.over(e.rank(), 'w; DROP'), 'r')).toThrow(ValidationError)
  })

  it('contains, startsWith and endsWith are case-sensitive, the i-variants are not', () => {
    expect(where(e => e.contains('a', 'x_'))).toEqual({ sql: 'SELECT * FROM "t" WHERE "a" LIKE $1', params: ['%x\\_%'] })
    expect(where(e => e.startsWith('a', 'x')).sql).toBe('SELECT * FROM "t" WHERE "a" LIKE $1')
    expect(where(e => e.iEndsWith('a', 'x'))).toEqual({ sql: 'SELECT * FROM "t" WHERE "a" ILIKE $1', params: ['%x'] })
    expect(select().where({ a: { iContains: 'x' } }).toSQL().sql).toBe('SELECT * FROM "t" WHERE "a" ILIKE $1')
  })
})

describe('select clauses on expressions', () => {
  it('orders by an expression, its parameters bound in place', () => {
    const q = select().where({ k: 1 }).orderBy(e => e.vectorCosineDistance('embedding', [1, 0]), 'asc', 'last').limit(5).toSQL()

    expect(q).toEqual({ sql: 'SELECT * FROM "t" WHERE "k" = $1 ORDER BY "embedding" <=> $2::vector ASC NULLS LAST LIMIT $3', params: [1, '[1,0]', 5] })
  })

  it('groups by an expression', () => {
    const q = select().pick('g').computed(e => e.countCol(), 'n').groupBy('g').groupByExpr(e => e.coalesce('a', 0)).toSQL()

    expect(q).toEqual({ sql: 'SELECT "g", CAST(COUNT(*) AS double precision) AS "n" FROM "t" GROUP BY "g", COALESCE("a", $1)', params: [0] })
  })

  it('takes a builder as a CTE, its placeholders numbered before the main query\'s', () => {
    const recent = new SelectBuilder<any>('posts').pick('author').where({ year: 2026 })
    const q = select().with('recent', recent).where(e => e.and(e.eq('x', 1), e.inSubquery('id', new SelectBuilder<any>('recent').pick('author')))).toSQL()

    expect(q).toEqual({ sql: 'WITH "recent" AS (SELECT "author" FROM "posts" WHERE "year" = $1) SELECT * FROM "t" WHERE ("x" = $2 AND "id" IN (SELECT "author" FROM "recent"))', params: [2026, 1] })
    expect(select().with('r', recent, true).toSQL().sql).toStartWith('WITH "r" AS (MATERIALIZED SELECT')
  })
})

describe('row locks', () => {
  it('FOR KEY SHARE, OF tables, NOWAIT', () => {
    expect(select().forKeyShare().toSQL().sql).toBe('SELECT * FROM "t" FOR KEY SHARE')
    expect(select().forUpdate().lockOf('t', 'w').noWait().toSQL().sql).toBe('SELECT * FROM "t" FOR UPDATE OF "t", "w" NOWAIT')
    expect(select().forShare().lockOf('t').skipLocked().toSQL().sql).toBe('SELECT * FROM "t" FOR SHARE OF "t" SKIP LOCKED')
  })

  it('refuses a lock modifier without a lock, SKIP LOCKED with NOWAIT, and a bad table name', () => {
    expect(() => select().noWait().toSQL()).toThrow(ValidationError)
    expect(() => select().lockOf('t').toSQL()).toThrow(ValidationError)
    expect(() => select().forUpdate().noWait().skipLocked().toSQL()).toThrow(ValidationError)
    expect(() => select().lockOf('t"; --')).toThrow(ValidationError)
  })

  it('drops the whole clause on SQLite', () => {
    expect(select().forUpdate().lockOf('t').noWait().toSQL('sqlite').sql).toBe('SELECT * FROM "t"')
  })
})

describe('writes reading other tables', () => {
  it('INSERT ... SELECT, its parameters numbered after nothing', () => {
    const q = new InsertBuilder<any>('archive').fromSelect(['id', 'name'], new SelectBuilder<any>('t').pick('id', 'name').where({ old: true })).returning('id').toSQL()

    expect(q).toEqual({ sql: 'INSERT INTO "archive" ("id", "name") SELECT "id", "name" FROM "t" WHERE "old" = $1 RETURNING "id"', params: [true] })
  })

  it('INSERT ... SELECT on SQLite ends the query before ON CONFLICT', () => {
    const q = new InsertBuilder<any>('archive').fromSelect(['id'], new SelectBuilder<any>('t').pick('id')).onConflict().doNothing().toSQL('sqlite')

    expect(q.sql).toBe('INSERT INTO "archive" ("id") SELECT * FROM (SELECT "id" FROM "t") WHERE true ON CONFLICT DO NOTHING')
  })

  it('bare ON CONFLICT DO NOTHING; DO UPDATE without a target throws', () => {
    expect(new InsertBuilder<any>('t').values({ a: 1 }).onConflict().doNothing().toSQL().sql).toBe('INSERT INTO "t" ("a") VALUES ($1) ON CONFLICT DO NOTHING')
    expect(() => new InsertBuilder<any>('t').values({ a: 1 }).onConflict([]).doUpdate('a').toSQL()).toThrow(ValidationError)
  })

  it('INSERT ... SELECT copies its selected columns on conflict, and an upsert without a target throws', () => {
    const q = new InsertBuilder<any>('archive').fromSelect(['id', 'name'], new SelectBuilder<any>('t').pick('id', 'name')).onConflict(['id']).doUpdate().toSQL()

    expect(q.sql).toBe('INSERT INTO "archive" ("id", "name") SELECT "id", "name" FROM "t" ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"')
    expect(() => new UpsertBuilder<any>('t').values({ a: 1 }).onConflict().toSQL()).toThrow(ValidationError)
  })

  it('UPDATE ... FROM qualifies its own columns and sets from the other table', () => {
    const q = new UpdateBuilder<any>('t').from('o', 'o').set(e => ({ qty: e.ref('o.qty'), note: 'x' })).where(e => e.eq('id', e.ref('o.tid'))).returning().toSQL()

    expect(q).toEqual({ sql: 'UPDATE "t" SET "qty" = "o"."qty", "note" = $1 FROM "o" AS "o" WHERE "t"."id" = "o"."tid" RETURNING "t".*', params: ['x'] })
  })

  it('DELETE ... USING qualifies its own columns, on Postgres only', () => {
    const q = new DeleteBuilder<any>('t').using('o', 'o').where(e => e.and(e.eq('id', e.ref('o.tid')), e.eq('o.gone', true))).returning('id').toSQL()

    expect(q).toEqual({ sql: 'DELETE FROM "t" USING "o" AS "o" WHERE ("t"."id" = "o"."tid" AND "o"."gone" = $1) RETURNING "t"."id"', params: [true] })
    expect(() => new DeleteBuilder<any>('t').using('o', 'o').where({ id: 1 }).toSQL('sqlite')).toThrow(DialectError)
  })

  it('refuses a from() table or alias that is not an identifier', () => {
    expect(() => new UpdateBuilder<any>('t').from('o; --', 'o')).toThrow(ValidationError)
    expect(() => new DeleteBuilder<any>('t').using('o', 'o o')).toThrow(ValidationError)
  })
})
