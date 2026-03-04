import { describe, expect, it } from 'bun:test'
import { SelectBuilder, SetOperationBuilder } from '../../../src/builder/query'

interface Cols { id: any, name: any, [key: string]: any }

function select() {
  return new SelectBuilder<Cols>('users')
}

describe('SetOperationBuilder', () => {
  it('UNION combines two queries', () => {
    const { sql } = SetOperationBuilder.union(select(), select()).toSQL()

    expect(sql).toContain('UNION')
    expect(sql.match(/SELECT/g)?.length).toBe(2)
  })

  it('UNION ALL keeps duplicates', () => {
    const { sql } = SetOperationBuilder.unionAll(select(), select()).toSQL()

    expect(sql).toContain('UNION ALL')
  })

  it('INTERSECT', () => {
    const { sql } = SetOperationBuilder.intersect(select(), select()).toSQL()

    expect(sql).toContain('INTERSECT')
  })

  it('EXCEPT', () => {
    const { sql } = SetOperationBuilder.except(select(), select()).toSQL()

    expect(sql).toContain('EXCEPT')
  })

  it('renumbers params across 3 queries', () => {
    const q1 = select().where(e => e.eq('id', 1))
    const q2 = select().where(e => e.eq('id', 2))
    const q3 = select().where(e => e.eq('id', 3))
    const { sql, params } = SetOperationBuilder.union(q1, q2, q3).toSQL()

    expect(params).toEqual([1, 2, 3])
    expect(sql).toContain('$1')
    expect(sql).toContain('$2')
    expect(sql).toContain('$3')
  })

  it('orderBy on set operation', () => {
    const { sql } = SetOperationBuilder.union(select(), select())
      .orderBy('name', 'desc')
      .toSQL()

    expect(sql).toContain('ORDER BY "name" DESC')
  })

  it('limit on set operation', () => {
    const { sql, params } = SetOperationBuilder.union(select(), select())
      .limit(5)
      .toSQL()

    expect(sql).toContain('LIMIT $')
    expect(params).toContain(5)
  })

  it('offset on set operation', () => {
    const { sql, params } = SetOperationBuilder.union(select(), select())
      .offset(10)
      .toSQL()

    expect(sql).toContain('OFFSET $')
    expect(params).toContain(10)
  })
})
