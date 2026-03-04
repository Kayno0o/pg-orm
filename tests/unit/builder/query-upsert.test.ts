import { describe, expect, it } from 'bun:test'
import { UpsertBuilder } from '../../../src/builder/query'

interface Cols { id: any, name: any, email: any, [key: string]: any }

function upsert() {
  return new UpsertBuilder<Cols>('users')
}

describe('UpsertBuilder', () => {
  it('generates INSERT with ON CONFLICT DO UPDATE', () => {
    const { sql, params: _params } = upsert()
      .values({ name: 'Alice', email: 'a@b.com' } as any)
      .onConflict('email')
      .toSQL()

    expect(sql).toContain('INSERT INTO "users"')
    expect(sql).toContain('ON CONFLICT ("email") DO UPDATE SET')
  })

  it('doUpdate with specific columns', () => {
    const { sql } = upsert()
      .values({ name: 'Alice', email: 'a@b.com' } as any)
      .onConflict('email')
      .doUpdate('name')
      .toSQL()

    expect(sql).toContain('DO UPDATE SET "name" = EXCLUDED."name"')
  })

  it('returning adds RETURNING', () => {
    const { sql } = upsert()
      .values({ name: 'Alice', email: 'a@b.com' } as any)
      .onConflict('email')
      .returning()
      .toSQL()

    expect(sql).toContain('RETURNING *')
  })

  it('validateValues rejects __raw', () => {
    expect(() => upsert().values({ name: { __raw: 'evil' } } as any)).toThrow(/__raw/)
  })

  it('clone produces independent copy', () => {
    const a = upsert().values({ name: 'Alice', email: 'a@b.com' } as any)
    const b = a.clone()

    b.onConflict('email')

    expect(a._state.conflictTarget).toBeNull()
  })

  it('explain wraps query', () => {
    const { sql } = upsert()
      .values({ name: 'Alice', email: 'a@b.com' } as any)
      .onConflict('email')
      .explain()

    expect(sql).toStartWith('EXPLAIN')
  })
})
