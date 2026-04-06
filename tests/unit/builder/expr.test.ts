import type { ExprTape } from '../../../src/builder/expr'
import { describe, expect, it } from 'bun:test'
import { assembleExpr, createExprBuilder } from '../../../src/builder/expr'

const e = createExprBuilder<any>()

function sql(tape: ExprTape, offset = 0) {
  return assembleExpr(tape, offset)
}

describe('ExprBuilder - Comparisons', () => {
  it('eq generates = with param', () => {
    const result = sql(e.eq('name', 'Alice'))

    expect(result.sql).toBe('"name" = $1')
    expect(result.params).toEqual(['Alice'])
  })

  it('eq with null generates IS NULL', () => {
    const result = sql(e.eq('name', null))

    expect(result.sql).toBe('"name" IS NULL')
    expect(result.params).toEqual([])
  })

  it('neq generates <>', () => {
    const result = sql(e.neq('name', 'Bob'))

    expect(result.sql).toBe('"name" <> $1')
    expect(result.params).toEqual(['Bob'])
  })

  it('neq with null generates IS NOT NULL', () => {
    const result = sql(e.neq('name', null))

    expect(result.sql).toBe('"name" IS NOT NULL')
  })

  it('gt generates >', () => {
    const result = sql(e.gt('age', 18))

    expect(result.sql).toBe('"age" > $1')
    expect(result.params).toEqual([18])
  })

  it('gte generates >=', () => {
    const result = sql(e.gte('age', 18))

    expect(result.sql).toBe('"age" >= $1')
  })

  it('lt generates <', () => {
    const result = sql(e.lt('age', 65))

    expect(result.sql).toBe('"age" < $1')
  })

  it('lte generates <=', () => {
    const result = sql(e.lte('age', 65))

    expect(result.sql).toBe('"age" <= $1')
  })
})

describe('ExprBuilder - Logic', () => {
  it('and combines with AND', () => {
    const result = sql(e.and(e.eq('a', 1), e.eq('b', 2)))

    expect(result.sql).toBe('("a" = $1 AND "b" = $2)')
    expect(result.params).toEqual([1, 2])
  })

  it('or combines with OR', () => {
    const result = sql(e.or(e.eq('a', 1), e.eq('b', 2)))

    expect(result.sql).toBe('("a" = $1 OR "b" = $2)')
  })

  it('not wraps with NOT', () => {
    const result = sql(e.not(e.eq('a', 1)))

    expect(result.sql).toBe('NOT ("a" = $1)')
  })

  it('nested and/or', () => {
    const result = sql(e.and(
      e.eq('a', 1),
      e.or(e.eq('b', 2), e.eq('c', 3)),
    ))

    expect(result.sql).toBe('("a" = $1 AND ("b" = $2 OR "c" = $3))')
    expect(result.params).toEqual([1, 2, 3])
  })

  it('and with 3+ operands', () => {
    const result = sql(e.and(e.eq('a', 1), e.eq('b', 2), e.eq('c', 3)))

    expect(result.sql).toBe('("a" = $1 AND "b" = $2 AND "c" = $3)')
  })
})

describe('ExprBuilder - IN/NOT IN', () => {
  it('in generates IN', () => {
    const result = sql(e.in('status', ['active', 'pending']))

    expect(result.sql).toBe('"status" IN ($1, $2)')
    expect(result.params).toEqual(['active', 'pending'])
  })

  it('notIn generates NOT IN', () => {
    const result = sql(e.notIn('status', ['deleted']))

    expect(result.sql).toBe('"status" NOT IN ($1)')
  })

  it('in with empty array returns FALSE', () => {
    const result = sql(e.in('status', []))

    expect(result.sql).toBe('FALSE')
    expect(result.params).toEqual([])
  })

  it('notIn with empty array returns TRUE', () => {
    const result = sql(e.notIn('status', []))

    expect(result.sql).toBe('TRUE')
  })
})

describe('ExprBuilder - NULL checks', () => {
  it('isNull generates IS NULL', () => {
    const result = sql(e.isNull('deletedAt'))

    expect(result.sql).toBe('"deletedAt" IS NULL')
  })

  it('isNotNull generates IS NOT NULL', () => {
    const result = sql(e.isNotNull('deletedAt'))

    expect(result.sql).toBe('"deletedAt" IS NOT NULL')
  })
})

describe('ExprBuilder - LIKE/ILIKE', () => {
  it('like generates LIKE', () => {
    const result = sql(e.like('name', '%test%'))

    expect(result.sql).toBe('"name" LIKE $1')
    expect(result.params).toEqual(['%test%'])
  })

  it('ilike generates ILIKE', () => {
    const result = sql(e.ilike('name', '%test%'))

    expect(result.sql).toBe('"name" ILIKE $1')
  })

  it('startsWith auto-escapes and adds trailing %', () => {
    const result = sql(e.startsWith('name', 'test%user'))

    expect(result.sql).toBe('"name" ILIKE $1')
    expect(result.params).toEqual(['test\\%user%'])
  })

  it('endsWith auto-escapes and adds leading %', () => {
    const result = sql(e.endsWith('name', 'test_user'))

    expect(result.params).toEqual(['%test\\_user'])
  })

  it('contains auto-escapes and adds both %', () => {
    const result = sql(e.contains('name', 'test'))

    expect(result.params).toEqual(['%test%'])
  })
})

describe('ExprBuilder - BETWEEN', () => {
  it('generates BETWEEN', () => {
    const result = sql(e.between('age', 18, 65))

    expect(result.sql).toBe('"age" BETWEEN $1 AND $2')
    expect(result.params).toEqual([18, 65])
  })
})

describe('ExprBuilder - EXISTS/NOT EXISTS', () => {
  it('exists generates EXISTS', () => {
    const subquery = { toSQL: (offset: number) => ({ sql: `SELECT 1 FROM "posts" WHERE "authorId" = $${offset + 1}`, params: [42] }) }
    const result = sql(e.exists(subquery))

    expect(result.sql).toContain('EXISTS')
    expect(result.params).toContain(42)
  })

  it('notExists generates NOT EXISTS', () => {
    const subquery = { toSQL: (_offset: number) => ({ sql: `SELECT 1`, params: [] }) }
    const result = sql(e.notExists(subquery))

    expect(result.sql).toContain('NOT EXISTS')
  })
})

describe('ExprBuilder - RAW', () => {
  it('raw passes SQL and params', () => {
    const result = sql(e.raw('? + ?', 1, 2))

    expect(result.sql).toBe('$1 + $2')
    expect(result.params).toEqual([1, 2])
  })

  it('raw with no params', () => {
    const result = sql(e.raw('TRUE'))

    expect(result.sql).toBe('TRUE')
    expect(result.params).toEqual([])
  })
})

describe('ExprBuilder - JSONB', () => {
  it('jsonbPath generates jsonb_path_exists', () => {
    const result = sql(e.jsonbPath('data', '$.name'))

    expect(result.sql).toBe('jsonb_path_exists("data", $1)')
    expect(result.params).toEqual(['$.name'])
  })

  it('jsonbSubscript generates parameterized -> path', () => {
    const result = sql(e.jsonbSubscript('data', 'a', 0, 'b'))

    expect(result.sql).toBe('((("data" -> $1) -> $2) -> $3)')
    expect(result.params).toEqual(['a', 0, 'b'])
  })

  it('jsonbSubscript parameterizes injection payloads', () => {
    const result = sql(e.jsonbSubscript('data', '\'; DROP TABLE users; --'))

    expect(result.sql).toBe('("data" -> $1)')
    expect(result.params).toEqual(['\'; DROP TABLE users; --'])
  })
})

describe('ExprBuilder - Full-text search', () => {
  it('tsMatch generates @@', () => {
    const q = e.tsQuery('english', 'hello world')
    const result = sql(e.tsMatch('searchVector', q))

    expect(result.sql).toContain('@@')
    expect(result.sql).toContain('plainto_tsquery')
    expect(result.params).toEqual(['hello world'])
  })

  it('tsQuery rejects invalid language', () => {
    expect(() => e.tsQuery('klingon', 'test')).toThrow()
  })
})

describe('ExprBuilder - Vector distance', () => {
  it('cosine distance generates <=>', () => {
    const result = sql(e.vectorCosineDistance('embedding', [1, 2, 3]))

    expect(result.sql).toContain('<=>')
    expect(result.sql).toContain('::vector')
  })

  it('L2 distance generates <->', () => {
    const result = sql(e.vectorL2Distance('embedding', [1, 2, 3]))

    expect(result.sql).toContain('<->')
  })

  it('inner product generates <#>', () => {
    const result = sql(e.vectorInnerProduct('embedding', [1, 2, 3]))

    expect(result.sql).toContain('<#>')
  })
})

describe('ExprBuilder - Array operators', () => {
  it('arrayContains generates = ANY()', () => {
    const result = sql(e.arrayContains('tags', 'important'))

    expect(result.sql).toBe('$1 = ANY("tags")')
    expect(result.params).toEqual(['important'])
  })

  it('arrayOverlap generates &&', () => {
    const result = sql(e.arrayOverlap('tags', ['a', 'b']))

    expect(result.sql).toBe('"tags" && ARRAY[$1, $2]')
    expect(result.params).toEqual(['a', 'b'])
  })
})

describe('ExprBuilder - Scalar subquery', () => {
  it('scalar wraps subquery in parens', () => {
    const subquery = { toSQL: (_offset: number) => ({ sql: `SELECT count(*) FROM "posts"`, params: [] }) }
    const result = sql(e.scalar(subquery))

    expect(result.sql).toBe('(SELECT count(*) FROM "posts")')
  })
})

describe('ExprBuilder - Ref', () => {
  it('ref quotes a dotted path', () => {
    const result = sql(e.ref('t.id'))

    expect(result.sql).toBe('"t"."id"')
  })
})

describe('ExprBuilder - Aggregates', () => {
  it('sum generates SUM()', () => {
    expect(e.sum('amount') as string).toBe('SUM("amount")')
  })

  it('avg generates AVG()', () => {
    expect(e.avg('price') as string).toBe('AVG("price")')
  })

  it('min generates MIN()', () => {
    expect(e.min('age') as string).toBe('MIN("age")')
  })

  it('max generates MAX()', () => {
    expect(e.max('age') as string).toBe('MAX("age")')
  })

  it('countCol generates COUNT()', () => {
    expect(e.countCol('id') as string).toBe('COUNT("id")')
    expect(e.countCol() as string).toBe('COUNT(*)')
  })

  it('jsonAgg generates json_agg()', () => {
    expect(e.jsonAgg('data') as string).toBe('json_agg("data")')
  })

  it('arrayAgg generates array_agg()', () => {
    expect(e.arrayAgg('id') as string).toBe('array_agg("id")')
  })

  it('stringAgg generates string_agg()', () => {
    expect(e.stringAgg('name', ', ') as string).toBe('string_agg("name", \', \')')
  })

  it('stringAgg allows common delimiters', () => {
    expect(() => e.stringAgg('name', ', ')).not.toThrow()
    expect(() => e.stringAgg('name', ' | ')).not.toThrow()
    expect(() => e.stringAgg('name', '; ')).not.toThrow()
    expect(() => e.stringAgg('name', '-')).not.toThrow()
  })

  it('stringAgg rejects injection payloads', () => {
    expect(() => e.stringAgg('name', '\'); DROP TABLE users; --')).toThrow('unsafe delimiter')
    expect(() => e.stringAgg('name', '\' || chr(0) || \'')).toThrow('unsafe delimiter')
  })
})

describe('ExprBuilder - param offset', () => {
  it('respects param offset', () => {
    const result = sql(e.eq('name', 'Alice'), 2)

    expect(result.sql).toBe('"name" = $3')
    expect(result.params).toEqual(['Alice'])
  })
})
