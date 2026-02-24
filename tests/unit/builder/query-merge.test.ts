import { describe, expect, it } from 'bun:test'
import { MergeBuilder } from '../../../src/builder/query'

interface Cols { id: any, name: any, value: any }

function merge() {
  return new MergeBuilder<Cols>('target')
}

describe('MergeBuilder', () => {
  it('generates MERGE INTO with USING', () => {
    const { sql } = merge().using('source', 's').on(e => e.ref('s.id')).toSQL()

    expect(sql).toContain('MERGE INTO "target"')
    expect(sql).toContain('USING "source" AS "s"')
  })

  it('whenMatched update', () => {
    const { sql, params } = merge()
      .using('source', 's')
      .on(e => e.ref('s.id'))
      .whenMatched('update', { name: 'updated' })
      .toSQL()

    expect(sql).toContain('WHEN MATCHED THEN UPDATE SET')
    expect(sql).toContain('"name" = $1')
    expect(params).toContain('updated')
  })

  it('whenMatchedDelete', () => {
    const { sql } = merge()
      .using('source', 's')
      .on(e => e.ref('s.id'))
      .whenMatchedDelete()
      .toSQL()

    expect(sql).toContain('WHEN MATCHED THEN DELETE')
  })

  it('whenNotMatched insert', () => {
    const { sql, params } = merge()
      .using('source', 's')
      .on(e => e.ref('s.id'))
      .whenNotMatched('insert', { name: 'new', value: 42 })
      .toSQL()

    expect(sql).toContain('WHEN NOT MATCHED THEN INSERT')
    expect(sql).toContain('"name"')
    expect(params).toContain('new')
  })

  it('whenNotMatchedBySource update', () => {
    const { sql } = merge()
      .using('source', 's')
      .on(e => e.ref('s.id'))
      .whenNotMatchedBySource('update', { name: 'orphaned' })
      .toSQL()

    expect(sql).toContain('WHEN NOT MATCHED BY SOURCE THEN UPDATE SET')
  })

  it('whenNotMatchedBySourceDelete', () => {
    const { sql } = merge()
      .using('source', 's')
      .on(e => e.ref('s.id'))
      .whenNotMatchedBySourceDelete()
      .toSQL()

    expect(sql).toContain('WHEN NOT MATCHED BY SOURCE THEN DELETE')
  })

  it('returning adds RETURNING', () => {
    const { sql } = merge()
      .using('source', 's')
      .on(e => e.ref('s.id'))
      .whenMatched('update', { name: 'x' })
      .returning()
      .toSQL()

    expect(sql).toContain('RETURNING *')
  })

  it('conditional whenMatched', () => {
    const { sql } = merge()
      .using('source', 's')
      .on(e => e.ref('s.id'))
      .whenMatched('update', { name: 'x' }, e => e.gt('value', 0))
      .toSQL()

    expect(sql).toContain('WHEN MATCHED AND "value" > $')
  })

  it('clone produces independent copy', () => {
    const a = merge().using('source', 's')
    const b = a.clone()

    b.on(e => e.ref('s.id'))

    expect(a._state.mergeOn).toBeNull()
  })
})
