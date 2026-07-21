import { describe, expect, it } from 'bun:test'
import { Database, defineTable } from '../../../src/index'

function makeDb() {
  return new Database({ url: 'postgres://test:test@127.0.0.1:8532/orm_test' })
}

function makeTable(name = 'cached') {
  return defineTable(name, t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
  }))
}

describe('database.repo memoization', () => {
  it('returns the same repository for the same table def', () => {
    const db = makeDb()
    const table = makeTable()

    expect(db.repo(table)).toBe(db.repo(table))
  })

  it('returns distinct repositories for distinct table defs', () => {
    const db = makeDb()

    expect(db.repo(makeTable('a'))).not.toBe(db.repo(makeTable('b')))
  })

  it('does not share repositories across Database instances', () => {
    const table = makeTable()

    expect(makeDb().repo(table)).not.toBe(makeDb().repo(table))
  })

  it('invalidates the cache when virtuals are added', () => {
    const db = makeDb()
    const table = makeTable()
    const before = db.repo(table)

    table.withVirtuals({ upper: row => String(row.name).toUpperCase() })

    expect(db.repo(table)).not.toBe(before)
  })

  it('invalidates the cache when relations are added', () => {
    const db = makeDb()
    const table = makeTable()
    const before = db.repo(table)

    table.withRelations(r => ({ others: r.hasMany('other', 'cached_id') }))

    expect(db.repo(table)).not.toBe(before)
  })

  it('invalidates the cache when a trait is applied', () => {
    const db = makeDb()
    const table = makeTable()
    const before = db.repo(table)

    table.withTrait({ name: 'noop', meta: { noop: true } })

    expect(db.repo(table)).not.toBe(before)
  })

  it('invalidateCache() drops memoized repositories', () => {
    const db = makeDb()
    const table = makeTable()
    const before = db.repo(table)

    db.invalidateCache()

    expect(db.repo(table)).not.toBe(before)
  })

  it('using(tx) still returns a fresh repository', () => {
    const db = makeDb()
    const table = makeTable()
    const repo = db.repo(table)

    expect(repo.using(db)).not.toBe(repo)
  })
})
