import { describe, expect, it } from 'bun:test'
import { SelectBuilder } from '../../../src/builder/query'

interface Cols {
  id: any
  name: any
  age: any
  email: any
  status: any
  department: any
  salary: any
  metadata: any
  tags: any
  searchVector: any
  [key: string]: any
}

function select() {
  return new SelectBuilder<Cols>('users')
}

describe('Complex query builder', () => {
  // --- CTEs ---

  describe('CTEs', () => {
    it('generates WITH clause', () => {
      const { sql, params } = select()
        .with('active_users', 'SELECT * FROM users WHERE status = $1', ['active'])
        .toSQL()

      expect(sql).toContain('WITH "active_users" AS (SELECT * FROM users WHERE status = $1)')
      expect(params).toEqual(['active'])
    })

    it('generates WITH RECURSIVE', () => {
      const { sql } = select()
        .withRecursive('tree', 'SELECT id, parent_id FROM categories UNION ALL SELECT c.id, c.parent_id FROM categories c JOIN tree t ON c.parent_id = t.id')
        .toSQL()

      expect(sql).toContain('WITH RECURSIVE "tree" AS (')
      expect(sql).toContain('UNION ALL')
    })

    it('supports MATERIALIZED hint', () => {
      const { sql } = select()
        .with('cached', 'SELECT * FROM expensive_view', [], true)
        .toSQL()

      expect(sql).toContain('MATERIALIZED SELECT * FROM expensive_view')
    })

    it('supports NOT MATERIALIZED hint', () => {
      const { sql } = select()
        .with('inline', 'SELECT * FROM simple_view', [], false)
        .toSQL()

      expect(sql).toContain('NOT MATERIALIZED SELECT * FROM simple_view')
    })

    it('chains multiple CTEs', () => {
      const { sql, params } = select()
        .with('a', 'SELECT * FROM t1 WHERE x = $1', [1])
        .with('b', 'SELECT * FROM t2 WHERE y = $1', [2])
        .toSQL()

      expect(sql).toContain('"a" AS')
      expect(sql).toContain('"b" AS')
      expect(params).toEqual([1, 2])
    })
  })

  // --- Window functions ---

  describe('Window functions', () => {
    it('generates WINDOW clause', () => {
      const { sql } = select()
        .window('w', { partitionBy: ['department'], orderBy: [{ col: 'salary', dir: 'desc' }] })
        .toSQL()

      expect(sql).toContain('WINDOW "w" AS (PARTITION BY "department" ORDER BY "salary" DESC)')
    })

    it('supports window with partition only', () => {
      const { sql } = select()
        .window('w', { partitionBy: ['department'] })
        .toSQL()

      expect(sql).toContain('WINDOW "w" AS (PARTITION BY "department")')
    })

    it('supports window with order only', () => {
      const { sql } = select()
        .window('w', { orderBy: [{ col: 'id', dir: 'asc' }] })
        .toSQL()

      expect(sql).toContain('WINDOW "w" AS (ORDER BY "id" ASC)')
    })

    it('computed column with window reference', () => {
      const { sql } = select()
        .window('w', { partitionBy: ['department'], orderBy: [{ col: 'salary', dir: 'desc' }] })
        .computedRaw('ROW_NUMBER() OVER w', 'rank')
        .toSQL()

      expect(sql).toContain('ROW_NUMBER() OVER w AS "rank"')
    })
  })

  // --- JOINs ---

  describe('JOINs', () => {
    it('generates INNER JOIN', () => {
      const { sql } = select()
        .join('orders', 'o', e => e.raw('"o"."userId" = "users"."id"'))
        .toSQL()

      expect(sql).toContain('INNER JOIN "orders" AS "o" ON "o"."userId" = "users"."id"')
    })

    it('generates LEFT JOIN', () => {
      const { sql } = select()
        .leftJoin('profiles', 'p', e => e.raw('"p"."userId" = "users"."id"'))
        .toSQL()

      expect(sql).toContain('LEFT JOIN "profiles" AS "p" ON "p"."userId" = "users"."id"')
    })

    it('generates RIGHT JOIN', () => {
      const { sql } = select()
        .rightJoin('orders', 'o', e => e.raw('"o"."userId" = "users"."id"'))
        .toSQL()

      expect(sql).toContain('RIGHT JOIN "orders" AS "o"')
    })

    it('generates FULL JOIN', () => {
      const { sql } = select()
        .fullJoin('orders', 'o', e => e.raw('"o"."userId" = "users"."id"'))
        .toSQL()

      expect(sql).toContain('FULL JOIN "orders" AS "o"')
    })

    it('chains multiple joins', () => {
      const { sql } = select()
        .join('orders', 'o', e => e.raw('"o"."userId" = "users"."id"'))
        .leftJoin('profiles', 'p', e => e.raw('"p"."userId" = "users"."id"'))
        .toSQL()

      expect(sql).toContain('INNER JOIN')
      expect(sql).toContain('LEFT JOIN')
    })
  })

  // --- GROUP BY + HAVING ---

  describe('GROUP BY + HAVING', () => {
    it('generates GROUP BY', () => {
      const { sql } = select()
        .groupBy('department')
        .toSQL()

      expect(sql).toContain('GROUP BY "department"')
    })

    it('generates GROUP BY with multiple columns', () => {
      const { sql } = select()
        .groupBy('department', 'status')
        .toSQL()

      expect(sql).toContain('GROUP BY "department", "status"')
    })

    it('generates HAVING', () => {
      const { sql, params } = select()
        .groupBy('department')
        .having(e => e.gt('salary', 50000))
        .toSQL()

      expect(sql).toContain('HAVING "salary" > $1')
      expect(params).toEqual([50000])
    })

    it('combines GROUP BY + HAVING + aggregate', () => {
      const { sql } = select()
        .aggregate(e => ({
          total: e.countCol(),
          avgSalary: e.avg('salary'),
        }))
        .groupBy('department')
        .having(e => e.raw('COUNT(*) > ?', 5))
        .toSQL()

      expect(sql).toContain('COUNT(*) AS "total"')
      expect(sql).toContain('AVG("salary") AS "avgSalary"')
      expect(sql).toContain('GROUP BY "department"')
      expect(sql).toContain('HAVING COUNT(*) > $1')
    })
  })

  // --- Aggregate functions ---

  describe('Aggregates', () => {
    it('generates SUM aggregate', () => {
      const { sql } = select()
        .aggregate(e => ({ total: e.sum('salary') }))
        .toSQL()

      expect(sql).toContain('SUM("salary") AS "total"')
    })

    it('generates AVG aggregate', () => {
      const { sql } = select()
        .aggregate(e => ({ avg: e.avg('salary') }))
        .toSQL()

      expect(sql).toContain('AVG("salary") AS "avg"')
    })

    it('generates MIN and MAX', () => {
      const { sql } = select()
        .aggregate(e => ({
          min: e.min('salary'),
          max: e.max('salary'),
        }))
        .toSQL()

      expect(sql).toContain('MIN("salary") AS "min"')
      expect(sql).toContain('MAX("salary") AS "max"')
    })

    it('generates COUNT', () => {
      const { sql } = select()
        .aggregate(e => ({ cnt: e.countCol() }))
        .toSQL()

      expect(sql).toContain('COUNT(*) AS "cnt"')
    })

    it('generates COUNT with column', () => {
      const { sql } = select()
        .aggregate(e => ({ cnt: e.countCol('email') }))
        .toSQL()

      expect(sql).toContain('COUNT("email") AS "cnt"')
    })

    it('generates json_agg', () => {
      const { sql } = select()
        .aggregate(e => ({ items: e.jsonAgg('name') }))
        .toSQL()

      expect(sql).toContain('json_agg("name") AS "items"')
    })

    it('generates array_agg', () => {
      const { sql } = select()
        .aggregate(e => ({ items: e.arrayAgg('name') }))
        .toSQL()

      expect(sql).toContain('array_agg("name") AS "items"')
    })

    it('generates string_agg', () => {
      const { sql } = select()
        .aggregate(e => ({ csv: e.stringAgg('name', ', ') }))
        .toSQL()

      expect(sql).toContain('string_agg("name", \', \') AS "csv"')
    })
  })

  // --- JSONB operators ---

  describe('JSONB operators', () => {
    it('generates jsonb_path_exists', () => {
      const { sql, params } = select()
        .where(e => e.jsonbPath('metadata', '$.active'))
        .toSQL()

      expect(sql).toContain('jsonb_path_exists("metadata", $1)')
      expect(params).toEqual(['$.active'])
    })

    it('generates JSONB subscript with parameterized -> operator', () => {
      const { sql, params } = select()
        .where(e => e.eq(e.jsonbSubscript('metadata', 'address', 'city'), 'Paris'))
        .toSQL()

      expect(sql).toContain('(("metadata" -> $1) -> $2)')
      expect(params).toContain('address')
      expect(params).toContain('city')
    })

    it('generates JSONB subscript with numeric index', () => {
      const { sql, params } = select()
        .where(e => e.eq(e.jsonbSubscript('tags', 0), 'important'))
        .toSQL()

      expect(sql).toContain('("tags" -> $1)')
      expect(params).toContain(0)
    })
  })

  // --- Array operators ---

  describe('Array operators', () => {
    it('generates array contains (ANY)', () => {
      const { sql, params } = select()
        .where(e => e.arrayContains('tags', 'important'))
        .toSQL()

      expect(sql).toContain('$1 = ANY("tags")')
      expect(params).toEqual(['important'])
    })

    it('generates array overlap (&&)', () => {
      const { sql, params } = select()
        .where(e => e.arrayOverlap('tags', ['a', 'b']))
        .toSQL()

      expect(sql).toContain('"tags" && ARRAY[$1, $2]')
      expect(params).toEqual(['a', 'b'])
    })
  })

  // --- Full-text search ---

  describe('Full-text search', () => {
    it('generates ts_match with plainto_tsquery', () => {
      const { sql, params } = select()
        .where(e => e.tsMatch('searchVector', e.tsQuery('english', 'hello world')))
        .toSQL()

      expect(sql).toContain('"searchVector" @@ plainto_tsquery(\'english\', $1)')
      expect(params).toEqual(['hello world'])
    })
  })

  // --- Locking ---

  describe('Row-level locking', () => {
    it('generates FOR UPDATE', () => {
      const { sql } = select()
        .where(e => e.eq('id', 1))
        .forUpdate()
        .toSQL()

      expect(sql).toContain('FOR UPDATE')
    })

    it('generates FOR SHARE', () => {
      const { sql } = select()
        .forShare()
        .toSQL()

      expect(sql).toContain('FOR SHARE')
    })

    it('generates FOR NO KEY UPDATE', () => {
      const { sql } = select()
        .forNoKeyUpdate()
        .toSQL()

      expect(sql).toContain('FOR NO KEY UPDATE')
    })

    it('generates FOR UPDATE SKIP LOCKED', () => {
      const { sql } = select()
        .forUpdate()
        .skipLocked()
        .toSQL()

      expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    })
  })

  // --- DISTINCT ---

  describe('DISTINCT', () => {
    it('generates SELECT DISTINCT', () => {
      const { sql } = select().distinct().toSQL()

      expect(sql).toContain('SELECT DISTINCT *')
    })

    it('generates DISTINCT ON', () => {
      const { sql } = select().distinctOn('department').toSQL()

      expect(sql).toContain('SELECT DISTINCT ON ("department") *')
    })
  })

  // --- ORDER BY edge cases ---

  describe('ORDER BY', () => {
    it('supports NULLS FIRST', () => {
      const { sql } = select().orderBy('age', 'asc', 'first').toSQL()

      expect(sql).toContain('ORDER BY "age" ASC NULLS FIRST')
    })

    it('supports NULLS LAST', () => {
      const { sql } = select().orderBy('age', 'desc', 'last').toSQL()

      expect(sql).toContain('ORDER BY "age" DESC NULLS LAST')
    })
  })

  // --- Subqueries ---

  describe('Subqueries', () => {
    it('generates EXISTS subquery', () => {
      const subq = new SelectBuilder<{ id: any, userId: any }>('orders')
        .where(e => e.raw('"orders"."userId" = "users"."id"'))

      const { sql } = select()
        .where(e => e.exists(subq))
        .toSQL()

      expect(sql).toContain('EXISTS (SELECT * FROM "orders"')
    })

    it('generates NOT EXISTS subquery', () => {
      const subq = new SelectBuilder<{ id: any, userId: any }>('orders')
        .where(e => e.raw('"orders"."userId" = "users"."id"'))

      const { sql } = select()
        .where(e => e.notExists(subq))
        .toSQL()

      expect(sql).toContain('NOT EXISTS (SELECT * FROM "orders"')
    })

    it('generates scalar subquery', () => {
      const subq = new SelectBuilder<{ id: any, userId: any, amount: any }>('orders')
        .aggregate(e => ({ total: e.sum('amount') }))
        .where(e => e.raw('"orders"."userId" = "users"."id"'))

      const { sql } = select()
        .where(e => e.gt(e.scalar(subq), 1000))
        .toSQL()

      expect(sql).toContain('(SELECT SUM("amount") AS "total" FROM "orders"')
    })
  })

  // --- Pattern matching convenience ---

  describe('Pattern matching', () => {
    it('startsWith generates ILIKE with escaped pattern', () => {
      const { sql, params } = select()
        .where(e => e.startsWith('name', 'Al'))
        .toSQL()

      expect(sql).toContain('ILIKE $1')
      expect(params).toEqual(['Al%'])
    })

    it('endsWith generates ILIKE with escaped pattern', () => {
      const { params } = select()
        .where(e => e.endsWith('name', 'ice'))
        .toSQL()

      expect(params).toEqual(['%ice'])
    })

    it('contains generates ILIKE with escaped pattern', () => {
      const { params } = select()
        .where(e => e.contains('name', 'li'))
        .toSQL()

      expect(params).toEqual(['%li%'])
    })

    it('escapes % and _ in user input', () => {
      const { params } = select()
        .where(e => e.startsWith('name', '50%_off'))
        .toSQL()

      expect(params).toEqual(['50\\%\\_off%'])
    })
  })

  // --- Branch ---

  describe('Branch', () => {
    it('branched builder is independent', () => {
      const original = select().where(e => e.eq('id', 1))
      const branched = original.branch().where(e => e.eq('name', 'Alice'))

      const { sql: originalSql } = original.toSQL()
      const { sql: branchedSql } = branched.toSQL()

      expect(originalSql).not.toContain('name')
      expect(branchedSql).toContain('name')
    })
  })

  // --- EXPLAIN ---

  describe('EXPLAIN', () => {
    it('generates EXPLAIN (FORMAT JSON)', () => {
      const { sql } = select().explain()

      expect(sql).toStartWith('EXPLAIN (FORMAT JSON)')
    })

    it('generates EXPLAIN with ANALYZE', () => {
      const { sql } = select().explain({ analyze: true })

      expect(sql).toStartWith('EXPLAIN (ANALYZE, FORMAT JSON)')
    })
  })

  // --- Alias ---

  describe('Alias', () => {
    it('generates table alias', () => {
      const { sql } = select().as('u').toSQL()

      expect(sql).toBe('SELECT * FROM "users" AS "u"')
    })
  })
})
