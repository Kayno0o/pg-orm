import type { ColumnDef, HasDefault, IsPrimaryKey, NoDefault, NotGenerated, NotNullable, NotPrimaryKey } from '../../../src/types/index'
import { describe, expect, it } from 'bun:test'
import { UpsertBuilder } from '../../../src/builder/query'

// eslint-disable-next-line ts/consistent-type-definitions
type Cols = {
  id: ColumnDef<number, NotNullable, HasDefault, IsPrimaryKey, NotGenerated>
  name: ColumnDef<string, NotNullable, NoDefault, NotPrimaryKey, NotGenerated>
  email: ColumnDef<string, NotNullable, NoDefault, NotPrimaryKey, NotGenerated>
}

function upsert() {
  return new UpsertBuilder<Cols>('users')
}

describe('UpsertBuilder', () => {
  it('generates INSERT with ON CONFLICT DO UPDATE', () => {
    const { sql, params: _params } = upsert()
      .values({ name: 'Alice', email: 'a@b.com' })
      .onConflict('email')
      .toSQL()

    expect(sql).toContain('INSERT INTO "users"')
    expect(sql).toContain('ON CONFLICT ("email") DO UPDATE SET')
  })

  it('doUpdate with specific columns', () => {
    const { sql } = upsert()
      .values({ name: 'Alice', email: 'a@b.com' })
      .onConflict('email')
      .doUpdate('name')
      .toSQL()

    expect(sql).toContain('DO UPDATE SET "name" = EXCLUDED."name"')
  })

  it('returning adds RETURNING', () => {
    const { sql } = upsert()
      .values({ name: 'Alice', email: 'a@b.com' })
      .onConflict('email')
      .returning()
      .toSQL()

    expect(sql).toContain('RETURNING *')
  })

  it('validateValues rejects __raw', () => {
    // @ts-expect-error — intentionally passing invalid type to test runtime validation
    expect(() => upsert().values({ name: { __raw: 'evil' } })).toThrow(/__raw/)
  })

  it('branch produces independent copy', () => {
    const a = upsert().values({ name: 'Alice', email: 'a@b.com' })
    const b = a.branch()

    b.onConflict('email')

    expect(a._state.conflictTarget).toBeNull()
  })

  it('explain wraps query', () => {
    const { sql } = upsert()
      .values({ name: 'Alice', email: 'a@b.com' })
      .onConflict('email')
      .explain()

    expect(sql).toStartWith('EXPLAIN')
  })
})
