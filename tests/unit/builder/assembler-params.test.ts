import type { ColumnDef, HasDefault, IsNullable, IsPrimaryKey, NoDefault, NotGenerated, NotNullable, NotPrimaryKey } from '../../../src/types/index'
import { describe, expect, test } from 'bun:test'
import { DeleteBuilder, InsertBuilder, MergeBuilder, SelectBuilder, UpdateBuilder } from '../../../src/builder/query'

// eslint-disable-next-line ts/consistent-type-definitions
type Cols = {
  id: ColumnDef<number, NotNullable, HasDefault, IsPrimaryKey, NotGenerated>
  name: ColumnDef<string, NotNullable, NoDefault, NotPrimaryKey, NotGenerated>
  age: ColumnDef<number, IsNullable, NoDefault, NotPrimaryKey, NotGenerated>
  email: ColumnDef<string, IsNullable, NoDefault, NotPrimaryKey, NotGenerated>
  status: ColumnDef<string, IsNullable, NoDefault, NotPrimaryKey, NotGenerated>
  score: ColumnDef<number, IsNullable, NoDefault, NotPrimaryKey, NotGenerated>
}

// Returns the distinct $N placeholder numbers found in a SQL string, in
// numeric order. Used to verify the assembler's positional accounting matches
// the params array it emits.
function placeholderNumbers(sql: string): number[] {
  const set = new Set<number>()
  const re = /\$(\d+)/g
  let m: RegExpExecArray | null

  m = re.exec(sql)

  while (m) {
    set.add(Number(m[1]))
    m = re.exec(sql)
  }

  return [...set].sort((a, b) => a - b)
}

function assertParamShape(sql: string, params: unknown[]) {
  const nums = placeholderNumbers(sql)

  if (params.length === 0) {
    expect(nums).toEqual([])

    return
  }

  // (a) distinct count matches params.length
  expect(nums.length).toBe(params.length)
  // (b) every $N for 1..params.length appears at least once
  expect(nums).toEqual(Array.from({ length: params.length }, (_, i) => i + 1))
}

describe('assembler — parameter accounting (SELECT)', () => {
  test('placeholder count equals params length for simple WHERE', () => {
    const { sql, params } = new SelectBuilder<Cols>('users')
      .where(e => e.eq('name', 'Alice'))
      .andWhere(e => e.gt('age', 18))
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual(['Alice', 18])
  })

  test('limit/offset add params at the tail', () => {
    const { sql, params } = new SelectBuilder<Cols>('users')
      .where(e => e.eq('status', 'active'))
      .limit(10)
      .offset(20)
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual(['active', 10, 20])
  })

  test('IN binds its list as one array on Postgres, one param per value on SQLite', () => {
    const q = new SelectBuilder<Cols>('users').where(e => e.in('id', [1, 2, 3, 4]))
    const { sql, params } = q.toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual([[1, 2, 3, 4]])
    expect(q.toSQL('sqlite').params).toEqual([1, 2, 3, 4])
  })

  test('zero-param query has zero placeholders', () => {
    const { sql, params } = new SelectBuilder<Cols>('users').toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual([])
  })
})

describe('assembler — parameter accounting (INSERT / UPDATE / DELETE)', () => {
  test('INSERT single row: one param per value', () => {
    const { sql, params } = new InsertBuilder<Cols>('users')
      .values({ name: 'Bob', age: 30, email: 'b@x.test' })
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toHaveLength(3)
  })

  test('INSERT many: one param per cell (rows × cols)', () => {
    const { sql, params } = new InsertBuilder<Cols>('users')
      .many([
        { name: 'A', age: 1 },
        { name: 'B', age: 2 },
        { name: 'C', age: 3 },
      ])
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual(['A', 1, 'B', 2, 'C', 3])
  })

  test('INSERT with ON CONFLICT DO UPDATE: only insertion params are bound', () => {
    const { sql, params } = new InsertBuilder<Cols>('users')
      .values({ id: 1, name: 'Alice' })
      .onConflict(['id'])
      .doUpdate('name')
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual([1, 'Alice'])
    expect(sql).toContain('ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"')
  })

  test('UPDATE SET ... WHERE: SET params first, WHERE params after', () => {
    const { sql, params } = new UpdateBuilder<Cols>('users')
      .set({ name: 'NewName', age: 25 })
      .where(e => e.eq('id', 99))
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual(['NewName', 25, 99])
  })

  test('DELETE WHERE: WHERE params only', () => {
    const { sql, params } = new DeleteBuilder<Cols>('users')
      .where(e => e.eq('id', 7))
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual([7])
  })
})

describe('assembler — parameter accounting (MERGE)', () => {
  test('MERGE with matched UPDATE and not-matched INSERT renumbers across clauses', () => {
    const { sql, params } = new MergeBuilder<Cols>('users')
      .using('staging', 's')
      .on(e => e.raw('"users"."id" = "s"."id"'))
      .whenMatched('update', { name: 'updated' })
      .whenNotMatched('insert', { id: 100, name: 'new' })
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual(['updated', 100, 'new'])
  })
})

describe('assembler — CTE renumbering', () => {
  test('renumbers $N in CTE body using current offset', () => {
    const { sql, params } = new SelectBuilder<Cols>('users')
      .with('active_users', 'SELECT * FROM users WHERE status = $1', ['active'])
      .where(e => e.gt('age', 18))
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual(['active', 18])
    expect(sql).toContain('WHERE status = $1')
    expect(sql).toContain('"age" > $2')
  })

  test('two CTEs each with one param → $1, $2, then main body at $3', () => {
    const { sql, params } = new SelectBuilder<Cols>('users')
      .with('a', 'SELECT * FROM t1 WHERE x = $1', [10])
      .with('b', 'SELECT * FROM t2 WHERE y = $1', [20])
      .where(e => e.eq('id', 30))
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual([10, 20, 30])
    // Each CTE has its own $1 in source, but the body picks them at offsets.
    expect(sql).toMatch(/"a" AS \(SELECT \* FROM t1 WHERE x = \$1\)/)
    expect(sql).toMatch(/"b" AS \(SELECT \* FROM t2 WHERE y = \$2\)/)
    expect(sql).toContain('"id" = $3')
  })

  test('CTE with duplicated and out-of-order placeholders is preserved', () => {
    const { sql, params } = new SelectBuilder<Cols>('users')
      .with('dup', 'SELECT * FROM t WHERE a = $1 OR b = $2 OR c = $1', ['x', 'y'])
      .where(e => e.eq('id', 1))
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual(['x', 'y', 1])

    // $1 from CTE source must be renumbered identically wherever it occurred.
    // After renumber: CTE's $1 → $1, CTE's $2 → $2, body $1 → $3. The dup
    // reference to source $1 must still match source $1's new number ($1).
    expect(sql).toMatch(/WHERE a = \$1 OR b = \$2 OR c = \$1/)
    expect(sql).toContain('"id" = $3')
  })

  test('CTE with no params still bumps placeholder count for body correctly', () => {
    const { sql, params } = new SelectBuilder<Cols>('users')
      .with('static', 'SELECT 1', [])
      .where(e => e.eq('id', 42))
      .toSQL()

    assertParamShape(sql, params)
    expect(params).toEqual([42])
    expect(sql).toContain('"id" = $1')
  })
})
