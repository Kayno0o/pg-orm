import { describe, expect, it } from 'bun:test'
import { SelectBuilder, SetOperationBuilder } from '../../../src/builder/query'

interface Cols {
  id: any
  name: any
  age: any
  email: any
  status: any
  deletedAt: any
  [key: string]: any
}

function select() {
  return new SelectBuilder<Cols>('users')
}

describe('SelectBuilder', () => {
  it('generates SELECT * FROM "table"', () => {
    const { sql } = select().toSQL()

    expect(sql).toBe('SELECT * FROM "users"')
  })

  it('pick selects specific columns', () => {
    const { sql } = select().pick('id', 'name').toSQL()

    expect(sql).toBe('SELECT "id", "name" FROM "users"')
  })

  it('omit excludes columns', () => {
    const b = select().pick('id', 'name', 'age').omit('age')
    const { sql } = b.toSQL()

    expect(sql).toBe('SELECT "id", "name" FROM "users"')
  })

  it('where generates WHERE clause', () => {
    const { sql, params } = select().where(e => e.eq('name', 'Alice')).toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE "name" = $1')
    expect(params).toEqual(['Alice'])
  })

  it('andWhere combines with AND', () => {
    const { sql, params } = select()
      .where(e => e.eq('name', 'Alice'))
      .andWhere(e => e.gt('age', 18))
      .toSQL()

    expect(sql).toBe('SELECT * FROM "users" WHERE ("name" = $1 AND "age" > $2)')
    expect(params).toEqual(['Alice', 18])
  })

  it('andWhere without prior where uses the new condition', () => {
    const { sql } = select().andWhere(e => e.eq('id', 1)).toSQL()

    expect(sql).toContain('WHERE "id" = $1')
  })

  it('orderBy single column', () => {
    const { sql } = select().orderBy('name').toSQL()

    expect(sql).toBe('SELECT * FROM "users" ORDER BY "name" ASC')
  })

  it('orderBy with desc and nulls', () => {
    const { sql } = select().orderBy('age', 'desc', 'last').toSQL()

    expect(sql).toContain('ORDER BY "age" DESC NULLS LAST')
  })

  it('limit validates non-negative integer', () => {
    expect(() => select().limit(-1)).toThrow(TypeError)
    expect(() => select().limit(1.5)).toThrow(TypeError)
    expect(() => select().limit(Number.NaN)).toThrow(TypeError)
  })

  it('limit accepts 0', () => {
    const { sql, params } = select().limit(0).toSQL()

    expect(sql).toContain('LIMIT $')
    expect(params).toContain(0)
  })

  it('limit accepts valid integer', () => {
    const { sql, params } = select().limit(10).toSQL()

    expect(sql).toContain('LIMIT $')
    expect(params).toContain(10)
  })

  it('offset validates non-negative integer', () => {
    expect(() => select().offset(-5)).toThrow(TypeError)
    expect(() => select().offset(2.5)).toThrow(TypeError)
  })

  it('offset accepts 0', () => {
    const { sql, params } = select().offset(0).toSQL()

    expect(sql).toContain('OFFSET $')
    expect(params).toContain(0)
  })

  it('distinct adds DISTINCT', () => {
    const { sql } = select().distinct().toSQL()

    expect(sql).toContain('SELECT DISTINCT')
  })

  it('distinctOn adds DISTINCT ON', () => {
    const { sql } = select().distinctOn('email').toSQL()

    expect(sql).toContain('DISTINCT ON ("email")')
  })

  it('groupBy adds GROUP BY', () => {
    const { sql } = select().groupBy('status').toSQL()

    expect(sql).toContain('GROUP BY "status"')
  })

  it('having adds HAVING', () => {
    const { sql } = select().groupBy('status').having(e => e.gt('age', 5)).toSQL()

    expect(sql).toContain('HAVING "age" > $1')
  })

  it('join adds JOIN', () => {
    const { sql } = select().join('posts', 'p', e => e.ref('p.authorId')).toSQL()

    expect(sql).toContain('INNER JOIN "posts" AS "p"')
  })

  it('leftJoin adds LEFT JOIN', () => {
    const { sql } = select().leftJoin('posts', 'p', e => e.ref('p.authorId')).toSQL()

    expect(sql).toContain('LEFT JOIN "posts" AS "p"')
  })

  it('rightJoin adds RIGHT JOIN', () => {
    const { sql } = select().rightJoin('posts', 'p', e => e.ref('p.authorId')).toSQL()

    expect(sql).toContain('RIGHT JOIN')
  })

  it('fullJoin adds FULL JOIN', () => {
    const { sql } = select().fullJoin('posts', 'p', e => e.ref('p.authorId')).toSQL()

    expect(sql).toContain('FULL JOIN')
  })

  it('computed adds computed column', () => {
    const { sql } = select().computed('1 + 1', 'two').toSQL()

    expect(sql).toContain('1 + 1 AS "two"')
  })

  it('forUpdate adds FOR UPDATE', () => {
    const { sql } = select().forUpdate().toSQL()

    expect(sql).toContain('FOR UPDATE')
  })

  it('forShare adds FOR SHARE', () => {
    const { sql } = select().forShare().toSQL()

    expect(sql).toContain('FOR SHARE')
  })

  it('skipLocked adds SKIP LOCKED', () => {
    const { sql } = select().forUpdate().skipLocked().toSQL()

    expect(sql).toContain('SKIP LOCKED')
  })

  it('window adds WINDOW clause', () => {
    const { sql } = select()
      .window('w', { partitionBy: ['status'], orderBy: [{ col: 'age', dir: 'asc' }] })
      .toSQL()

    expect(sql).toContain('WINDOW "w" AS (PARTITION BY "status" ORDER BY "age" ASC)')
  })

  it('with adds CTE', () => {
    const { sql, params: _params } = select().with('cte', 'SELECT 1 AS val', [], true).toSQL()

    expect(sql).toContain('WITH "cte" AS (MATERIALIZED SELECT 1 AS val)')
  })

  it('withRecursive adds RECURSIVE CTE', () => {
    const { sql } = select().withRecursive('cte', 'SELECT 1').toSQL()

    expect(sql).toContain('WITH RECURSIVE')
  })

  it('count changes op to count', () => {
    const { sql } = select().count().toSQL()

    expect(sql).toContain('SELECT count(*)')
  })

  it('aggregate uses computed columns', () => {
    const { sql } = select().aggregate(e => ({
      total: e.sum('age'),
      average: e.avg('age'),
    })).toSQL()

    expect(sql).toContain('SUM("age") AS "total"')
    expect(sql).toContain('AVG("age") AS "average"')
  })

  it('withTrashed sets flag', () => {
    const b = select().withTrashed()

    expect(b._state.withTrashed).toBe(true)
  })

  it('explain wraps query', () => {
    const { sql } = select().explain()

    expect(sql).toStartWith('EXPLAIN (FORMAT JSON)')
  })

  it('explain with analyze', () => {
    const { sql } = select().explain({ analyze: true })

    expect(sql).toStartWith('EXPLAIN (ANALYZE, FORMAT JSON)')
  })

  it('clone produces independent copy', () => {
    const a = select().where(e => e.eq('id', 1))
    const b = a.clone()

    b.limit(10)

    expect(a._state.limit).toBeNull()
    expect(b._state.limit).toBe(10)
  })

  it('as sets alias', () => {
    const { sql } = select().as('u').toSQL()

    expect(sql).toContain('FROM "users" AS "u"')
  })

  it('include adds include entry', () => {
    const b = select().include('posts')

    expect(b._state.includes).toHaveLength(1)
    expect(b._state.includes[0]!.relation).toBe('posts')
  })
})

describe('SetOperationBuilder', () => {
  it('union combines queries', () => {
    const q1 = select().where(e => e.eq('status', 'active'))
    const q2 = select().where(e => e.eq('status', 'pending'))
    const { sql, params } = SetOperationBuilder.union(q1, q2).toSQL()

    expect(sql).toContain('UNION')
    expect(params).toEqual(['active', 'pending'])
  })

  it('unionAll combines with UNION ALL', () => {
    const q1 = select()
    const q2 = select()
    const { sql } = SetOperationBuilder.unionAll(q1, q2).toSQL()

    expect(sql).toContain('UNION ALL')
  })

  it('intersect combines with INTERSECT', () => {
    const q1 = select()
    const q2 = select()
    const { sql } = SetOperationBuilder.intersect(q1, q2).toSQL()

    expect(sql).toContain('INTERSECT')
  })

  it('except combines with EXCEPT', () => {
    const q1 = select()
    const q2 = select()
    const { sql } = SetOperationBuilder.except(q1, q2).toSQL()

    expect(sql).toContain('EXCEPT')
  })

  it('renumbers params correctly across operands', () => {
    const q1 = select().where(e => e.eq('id', 1))
    const q2 = select().where(e => e.eq('id', 2))
    const { sql, params } = SetOperationBuilder.union(q1, q2).toSQL()

    expect(sql).toContain('$1')
    expect(sql).toContain('$2')
    expect(params).toEqual([1, 2])
  })

  it('limit/offset work on set operations', () => {
    const q1 = select()
    const q2 = select()
    const { sql, params } = SetOperationBuilder.union(q1, q2).limit(10).offset(5).toSQL()

    expect(sql).toContain('LIMIT $')
    expect(sql).toContain('OFFSET $')
    expect(params).toContain(10)
    expect(params).toContain(5)
  })

  it('limit validates on set operations', () => {
    const q1 = select()
    const q2 = select()

    expect(() => SetOperationBuilder.union(q1, q2).limit(-1)).toThrow(TypeError)
  })

  it('offset validates on set operations', () => {
    const q1 = select()
    const q2 = select()

    expect(() => SetOperationBuilder.union(q1, q2).offset(-1)).toThrow(TypeError)
  })

  it('orderBy works on set operations', () => {
    const q1 = select()
    const q2 = select()
    const { sql } = SetOperationBuilder.union(q1, q2).orderBy('name', 'desc').toSQL()

    expect(sql).toContain('ORDER BY "name" DESC')
  })
})
