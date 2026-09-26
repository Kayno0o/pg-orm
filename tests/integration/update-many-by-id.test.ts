import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { ValidationError } from '../../src/index'
import { createTestDb, truncateAll } from '../helpers/db'
import { bigItemsTable, documentsTable, usersTable, versionedItemsTable } from '../helpers/fixtures'

let db: Database
let statements = 0

beforeAll(async () => {
  db = createTestDb({ onQuery: () => {
    statements++
  } })
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

async function seedUsers() {
  return db.repo(usersTable).write.insertMany([
    { name: 'A', email: 'a@test.com', age: 1 },
    { name: 'B', email: 'b@test.com', age: 2 },
    { name: 'C', email: 'c@test.com', age: 3 },
  ])
}

describe('updateManyById', () => {
  it('writes each row its own values in one statement', async () => {
    const [a, b, c] = await seedUsers()

    statements = 0
    const ids = await db.repo(usersTable).write.updateManyById([{ id: a!, age: 30 }, { id: b!, age: 20 }, { id: c!, age: 10 }])

    expect(statements).toBe(1)
    expect([...ids].sort()).toEqual([a!, b!, c!].sort())

    const rows = await db.repo(usersTable).read.findMany(q => q.orderBy('id'))

    expect(rows.map(r => r.age)).toEqual([30, 20, 10])
  })

  it('leaves a column untouched on the rows that do not write it, and writes an explicit null', async () => {
    const [a, b] = await seedUsers()

    await db.repo(usersTable).write.updateManyById([{ id: a!, name: 'A2' }, { id: b!, age: null }])

    const [rowA, rowB] = await db.repo(usersTable).read.findMany(q => q.where({ id: [a!, b!] }).orderBy('id'))

    expect([rowA!.name, rowA!.age]).toEqual(['A2', 1])
    expect([rowB!.name, rowB!.age]).toEqual(['B', null])
  })

  it('runs beforeUpdate hooks and traits: updatedAt and the optimistic-lock version move', async () => {
    const [a] = await seedUsers()
    const before = await db.repo(usersTable).read.findByIdOrThrow(a!)
    const item = await db.repo(versionedItemsTable).write.insertOne({ name: 'v' })

    await Bun.sleep(5)
    await db.repo(usersTable).write.updateManyById([{ id: a!, age: 99 }])
    const [bumped] = await db.repo(versionedItemsTable).write.updateManyById([{ id: item, value: 5 }], { full: true })

    const after = await db.repo(usersTable).read.findByIdOrThrow(a!)

    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
    expect([bumped!.value, bumped!.version]).toEqual([5, 2])
  })

  it('returns mapped rows with virtuals when asked for the full rows', async () => {
    const [a] = await seedUsers()
    const [row] = await db.repo(usersTable).write.updateManyById([{ id: a!, name: 'Full' }], { full: true })

    expect(row).toMatchObject({ id: a, name: 'Full', isDeleted: false })
  })

  it('round-trips jsonb and bigint values', async () => {
    const doc = await db.repo(documentsTable).write.insertOne({ data: { name: 'd', tags: [] } })
    const big = await db.repo(bigItemsTable).write.insertOne({ big: 1n })

    await db.repo(documentsTable).write.updateManyById([{ id: doc, data: { name: 'd2', tags: ['x'] } }])
    await db.repo(bigItemsTable).write.updateManyById([{ id: big, big: 9007199254740993n }])

    expect((await db.repo(documentsTable).read.findByIdOrThrow(doc)).data).toEqual({ name: 'd2', tags: ['x'] })
    expect((await db.repo(bigItemsTable).read.findByIdOrThrow(big)).big).toBe(9007199254740993n)
  })

  it('skips a key that matches no row', async () => {
    const [a] = await seedUsers()
    const ids = await db.repo(usersTable).write.updateManyById([{ id: a!, age: 7 }, { id: 999999, age: 7 }])

    expect(ids).toEqual([a!])
  })

  it('runs inside a transaction through using(tx)', async () => {
    const [a] = await seedUsers()

    await expect(db.transaction(async (tx) => {
      await db.repo(usersTable).using(tx).write.updateManyById([{ id: a!, age: 50 }])

      throw new Error('roll back')
    })).rejects.toThrow('roll back')

    expect((await db.repo(usersTable).read.findByIdOrThrow(a!)).age).toBe(1)
  })

  it('does nothing on an empty list and rejects bad input before querying', async () => {
    const [a] = await seedUsers()
    const repo = db.repo(usersTable).write

    statements = 0
    expect(await repo.updateManyById([])).toEqual([])
    // @ts-expect-error the primary key is required
    await expect(repo.updateManyById([{ age: 1 }])).rejects.toBeInstanceOf(ValidationError)
    await expect(repo.updateManyById([{ id: a!, age: 1 }, { id: a!, age: 2 }])).rejects.toBeInstanceOf(ValidationError)
    // @ts-expect-error not a column
    await expect(repo.updateManyById([{ id: a!, nope: 1 }])).rejects.toBeInstanceOf(ValidationError)
    expect(statements).toBe(0)
  })
})
