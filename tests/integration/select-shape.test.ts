import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { rawExpr } from '../../src/index'
import { createTestDb, truncateAll } from '../helpers/db'
import { postsTable, usersTable } from '../helpers/fixtures'

let db: Database
const queries: string[] = []

beforeAll(async () => {
  db = createTestDb({ onQuery: ({ sql }) => void queries.push(sql) })
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  queries.length = 0
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

async function seed() {
  const ada = await db.repo(usersTable).write.insertOne({ name: 'Ada', email: 'ada@test.com', age: 30 })

  await db.repo(usersTable).write.insertMany([{ name: 'Bob', email: 'bob@test.com', age: 30 }, { name: 'Cy', email: 'cy@test.com', age: 40 }], { pk: true })
  await db.repo(postsTable).write.insertOne({ title: 't', body: 'b', authorId: ada.id }, { pk: true })
  queries.length = 0
}

describe('pick and omit after other reshaping', () => {
  it('keep computed, include and withCount fields, in the type as in the row', async () => {
    await seed()

    const rows = await db.repo(usersTable).read.findMany(q => q
      .computedRaw(rawExpr<number>('1'), 'one')
      .withCount('posts')
      .include('posts')
      .pick('id', 'name')
      .where({ name: 'Ada' }))
    const typed: { id: number, name: string, one: number, postsCount: number, posts: { title: string }[] }[] = rows

    expect(typed).toMatchObject([{ name: 'Ada', one: 1, postsCount: 1, posts: [{ title: 't' }] }])
    expect(Object.keys(typed[0]!).sort()).toEqual(['id', 'isDeleted', 'name', 'one', 'posts', 'postsCount'])
  })

  it('omit leaves the columns out of the SELECT and the type', async () => {
    await seed()

    const rows = await db.repo(usersTable).read.findMany(q => q.omit('email', 'age').where({ name: 'Ada' }))

    // @ts-expect-error an omitted column is gone from the type
    expect(rows[0]!.email).toBeUndefined()
    expect(rows[0]).not.toHaveProperty('age')
    expect(rows[0]!.name).toBe('Ada')
    expect(queries[0]).not.toContain('*')
    expect(queries[0]).not.toContain('"email"')
  })
})

describe('grouped aggregates', () => {
  it('select their group columns whatever the call order', async () => {
    await seed()

    const before = await db.repo(usersTable).read.findMany(q => q.groupBy('age').aggregate(e => ({ first: e.min('name') })).orderBy('age'))
    const after = await db.repo(usersTable).read.findMany(q => q.aggregate(e => ({ first: e.min('name') })).groupBy('age').orderBy('age'))
    const typed: { age: number | null, first: string }[] = before

    expect(typed).toMatchObject([{ age: 30, first: 'Ada' }, { age: 40, first: 'Cy' }])
    expect(after).toEqual(before)
  })
})
