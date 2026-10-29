import type { Database, QueryEvent } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createTestDb, truncateAll } from '../helpers/db'
import { usersTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

async function seedUsers(count: number) {
  const repo = db.repo(usersTable)

  return repo.write.insertMany(
    Array.from({ length: count }, (_, i) => ({
      name: `User ${String(i + 1).padStart(3, '0')}`,
      email: `user${i + 1}@test.com`,
      age: 20 + i,
    })),
    { pk: true },
  )
}

async function seedAges(ages: number[]) {
  await db.repo(usersTable).write.insertMany(ages.map((age, i) => ({ name: `U${i}`, email: `age${i}@test.com`, age })), { pk: true })
}

describe('Offset Pagination', () => {
  it('returns correct page', async () => {
    await seedUsers(15)
    const repo = db.repo(usersTable)
    const result = await repo.read.paginate({ page: 1, perPage: 5 })

    expect(result.data).toHaveLength(5)
    expect(result.total).toBe(15)
    expect(result.page).toBe(1)
    expect(result.perPage).toBe(5)
    expect(result.totalPages).toBe(3)
  })

  it('returns second page', async () => {
    await seedUsers(15)
    const repo = db.repo(usersTable)
    const result = await repo.read.paginate({ page: 2, perPage: 5 })

    expect(result.data).toHaveLength(5)
    expect(result.page).toBe(2)
  })

  it('returns last page with fewer items', async () => {
    await seedUsers(12)
    const repo = db.repo(usersTable)
    const result = await repo.read.paginate({ page: 3, perPage: 5 })

    expect(result.data).toHaveLength(2)
    expect(result.totalPages).toBe(3)
  })

  it('returns empty data for page beyond total', async () => {
    await seedUsers(5)
    const repo = db.repo(usersTable)
    const result = await repo.read.paginate({ page: 3, perPage: 5 })

    expect(result.data).toHaveLength(0)
    expect(result.total).toBe(5)
  })

  it('reads a page and its total in one query', async () => {
    await seedUsers(12)

    const events: QueryEvent[] = []
    const counted = createTestDb({ onQuery: e => events.push(e) })

    try {
      const result = await counted.repo(usersTable).read.paginate({ page: 2, perPage: 5 }, q => q.orderBy('age'))

      expect(result.data.map(u => u.age)).toEqual([25, 26, 27, 28, 29])
      expect(result.total).toBe(12)
      expect(events).toHaveLength(1)
    }
    finally {
      await counted.close()
    }
  })

  it('supports where filter', async () => {
    await seedUsers(10)
    const repo = db.repo(usersTable)
    const result = await repo.read.paginate({
      page: 1,
      perPage: 5,
      where: e => e.gte('age', 25),
    })

    expect(result.total).toBe(5) // ages 25-29
    expect(result.data).toHaveLength(5)
  })

  it('counts groups, not rows, when the callback groups', async () => {
    await seedAges([20, 20, 21, 21, 22])

    const result = await db.repo(usersTable).read.paginate({ page: 1, perPage: 2 }, q => q.pick('age').groupBy('age').orderBy('age'))

    expect(result.data).toHaveLength(2)
    expect(result.total).toBe(3)
    expect(result.totalPages).toBe(2)
  })

  it('counts distinct rows when the callback selects distinct', async () => {
    await seedAges([20, 20, 21, 21, 22])

    const result = await db.repo(usersTable).read.paginate({ page: 1, perPage: 2 }, q => q.pick('age').distinct().orderBy('age'))

    expect(result.data).toHaveLength(2)
    expect(result.total).toBe(3)
  })
})

describe('Cursor Pagination', () => {
  it('forward pagination returns first page', async () => {
    await seedUsers(10)
    const repo = db.repo(usersTable)
    const result = await repo.read.paginateCursor({ take: 3 })

    expect(result.data).toHaveLength(3)
    expect(result.nextCursor).not.toBeNull()
  })

  it('forward pagination follows cursor', async () => {
    await seedUsers(10)
    const repo = db.repo(usersTable)
    const page1 = await repo.read.paginateCursor({ take: 3, column: 'id' })
    const page2 = await repo.read.paginateCursor({
      take: 3,
      column: 'id',
      cursor: page1.nextCursor,
    })

    expect(page2.data).toHaveLength(3)

    // No overlap between pages
    const page1Ids = page1.data.map(u => u.id)
    const page2Ids = new Set(page2.data.map(u => u.id))

    expect(page1Ids.some(id => page2Ids.has(id))).toBe(false)
  })

  it('last page returns null cursor', async () => {
    await seedUsers(5)
    const repo = db.repo(usersTable)
    const page1 = await repo.read.paginateCursor({ take: 3, column: 'id' })
    const page2 = await repo.read.paginateCursor({
      take: 3,
      column: 'id',
      cursor: page1.nextCursor,
    })

    expect(page2.data).toHaveLength(2)
    expect(page2.nextCursor).toBeNull()
  })

  it('backward pagination', async () => {
    await seedUsers(10)
    const repo = db.repo(usersTable)
    // Get the last few items
    const allUsers = await repo.read.findMany(q => q.orderBy('id', 'asc'))
    const lastId = allUsers.at(-1)!.id

    const result = await repo.read.paginateCursor({
      take: 3,
      column: 'id',
      cursor: lastId,
      direction: 'backward',
    })

    expect(result.data).toHaveLength(3)
    // Results should be in ascending order (reversed from backward fetch)
    expect(result.data[0]!.id).toBeLessThan(result.data[2]!.id)
  })

  it('empty table returns empty data and null cursor', async () => {
    const repo = db.repo(usersTable)
    const result = await repo.read.paginateCursor({ take: 5 })

    expect(result.data).toHaveLength(0)
    expect(result.nextCursor).toBeNull()
  })

  it('supports where filter', async () => {
    await seedUsers(10)
    const repo = db.repo(usersTable)
    const result = await repo.read.paginateCursor({
      take: 3,
      where: e => e.gte('age', 25),
    })

    expect(result.data.length).toBeGreaterThan(0)
    expect(result.data.every(u => (u.age ?? 0) >= 25)).toBe(true)
  })
})
