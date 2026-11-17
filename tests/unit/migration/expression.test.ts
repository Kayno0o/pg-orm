import { describe, expect, test } from 'bun:test'
import { sameExpression } from '../../../src/migration/expression'

describe('sameExpression', () => {
  test('a different grouping is a different expression', () => {
    expect(sameExpression('(a = 1 OR b = 2) AND c = 3', 'a = 1 OR (b = 2 AND c = 3)')).toBe(false)
    expect(sameExpression('NOT (a AND b)', 'NOT a AND b')).toBe(false)
    expect(sameExpression('(a + b) * c', 'a + (b * c)')).toBe(false)
    expect(sameExpression('a - (b - c)', '(a - b) - c')).toBe(false)
  })

  test('what Postgres adds or drops when it prints an expression back is not a difference', () => {
    expect(sameExpression('"kind" = \'x\'', '((kind = \'x\'::text))')).toBe(true)
    expect(sameExpression('resource_id IS NULL AND kind = \'x\'', '((resource_id IS NULL) AND (kind = \'x\'::text))')).toBe(true)
    expect(sameExpression('"resource_id" IS NOT NULL', '(resource_id IS NOT NULL)')).toBe(true)
    expect(sameExpression('lower(name)', 'lower((name)::text)')).toBe(true)
    expect(sameExpression('(a + b) * c', '((a + b) * c)')).toBe(true)
    expect(sameExpression('price * qty', '(price * (qty)::numeric)')).toBe(true)
    expect(sameExpression('created < now()', '(created < (now())::timestamp with time zone)')).toBe(true)
    expect(sameExpression('a != 1', '(a <> 1)')).toBe(true)
    expect(sameExpression('a AND b AND c', '((a AND b) AND c)')).toBe(true)
    expect(sameExpression('(a AND b) AND c', 'a AND (b AND c)')).toBe(true)
    expect(sameExpression('x IN (1, 2)', '(x IN (1, 2))')).toBe(true)
    expect(sameExpression('x BETWEEN 1 AND 5', '((x >= 1) AND (x <= 5))')).toBe(true)
    expect(sameExpression('x NOT BETWEEN 1 AND 5', '((x < 1) OR (x > 5))')).toBe(true)
  })

  test('a literal is compared as written', () => {
    expect(sameExpression('kind = \'A\'', 'kind = \'a\'')).toBe(false)
  })

  test('an expression beyond the grammar is compared without its parentheses and casts', () => {
    expect(sameExpression('kind = ANY (ARRAY[\'x\'])', '(kind = ANY (ARRAY[\'x\'::text]))')).toBe(true)
    expect(sameExpression('kind = ANY (ARRAY[\'x\'])', '(kind = ANY (ARRAY[\'y\'::text]))')).toBe(false)
  })

  test('no expression matches none', () => {
    expect(sameExpression(undefined, undefined)).toBe(true)
    expect(sameExpression('a = 1', undefined)).toBe(false)
  })
})
