import type { Database } from '../../src/index'
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

describe('CRUD - insertOne', () => {
  it('inserts and returns a row', async () => {
    const repo = db.repo(usersTable)
    const user = await repo.insertOne({ name: 'Alice', email: 'alice@test.com' })

    expect(user.id).toBeDefined()
    expect(user.name).toBe('Alice')
    expect(user.email).toBe('alice@test.com')
  })

  it('auto-sets createdAt/updatedAt via timestamps trait', async () => {
    const repo = db.repo(usersTable)
    const user = await repo.insertOne({ name: 'Bob', email: 'bob@test.com' })

    expect((user as any).createdAt).toBeInstanceOf(Date)
    expect((user as any).updatedAt).toBeInstanceOf(Date)
  })

  it('inserts with nullable field', async () => {
    const repo = db.repo(usersTable)
    const user = await repo.insertOne({ name: 'Charlie', email: 'charlie@test.com', age: 30 })

    expect(user.age).toBe(30)
  })

  it('inserts with null nullable field', async () => {
    const repo = db.repo(usersTable)
    const user = await repo.insertOne({ name: 'Dave', email: 'dave@test.com', age: null })

    expect(user.age).toBeNull()
  })
})

describe('CRUD - insertMany', () => {
  it('inserts multiple rows', async () => {
    const repo = db.repo(usersTable)
    const users = await repo.insertMany([
      { name: 'A', email: 'a@test.com' },
      { name: 'B', email: 'b@test.com' },
      { name: 'C', email: 'c@test.com' },
    ])

    expect(users).toHaveLength(3)
    expect(users[0]!.name).toBe('A')
  })

  it('returns empty array for empty input', async () => {
    const repo = db.repo(usersTable)
    const result = await repo.insertMany([])

    expect(result).toEqual([])
  })
})

describe('CRUD - findMany', () => {
  it('finds all rows', async () => {
    const repo = db.repo(usersTable)

    await repo.insertMany([
      { name: 'A', email: 'a@test.com' },
      { name: 'B', email: 'b@test.com' },
    ])
    const users = await repo.findMany()

    expect(users).toHaveLength(2)
  })

  it('filters with where', async () => {
    const repo = db.repo(usersTable)

    await repo.insertMany([
      { name: 'Alice', email: 'alice@test.com' },
      { name: 'Bob', email: 'bob@test.com' },
    ])
    const users = await repo.findMany(q => q.where(e => e.eq('name', 'Alice')))

    expect(users).toHaveLength(1)
    expect(users[0]!.name).toBe('Alice')
  })

  it('orders results', async () => {
    const repo = db.repo(usersTable)

    await repo.insertMany([
      { name: 'Charlie', email: 'c@test.com' },
      { name: 'Alice', email: 'a@test.com' },
      { name: 'Bob', email: 'b@test.com' },
    ])
    const users = await repo.findMany(q => q.orderBy('name', 'asc'))

    expect(users[0]!.name).toBe('Alice')
    expect(users[2]!.name).toBe('Charlie')
  })

  it('limits results', async () => {
    const repo = db.repo(usersTable)

    await repo.insertMany([
      { name: 'A', email: 'a@test.com' },
      { name: 'B', email: 'b@test.com' },
      { name: 'C', email: 'c@test.com' },
    ])
    const users = await repo.findMany(q => q.limit(2))

    expect(users).toHaveLength(2)
  })

  it('picks specific columns', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    const users = await repo.findMany(q => q.pick('id', 'name'))

    expect(users[0]).toHaveProperty('name')
    expect(users[0]).toHaveProperty('id')
  })
})

describe('CRUD - findOne', () => {
  it('returns first matching row', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    const user = await repo.findOne(q => q.where(e => e.eq('name', 'Alice')))

    expect(user).not.toBeNull()
    expect(user!.name).toBe('Alice')
  })

  it('returns null when not found', async () => {
    const repo = db.repo(usersTable)
    const user = await repo.findOne(q => q.where(e => e.eq('name', 'Ghost')))

    expect(user).toBeNull()
  })
})

describe('CRUD - findById', () => {
  it('finds row by id', async () => {
    const repo = db.repo(usersTable)
    const inserted = await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    const found = await repo.findById(inserted.id)

    expect(found).not.toBeNull()
    expect(found!.id).toBe(inserted.id)
  })

  it('returns null for missing id', async () => {
    const repo = db.repo(usersTable)
    const found = await repo.findById(999999)

    expect(found).toBeNull()
  })
})

describe('CRUD - updateMany', () => {
  it('updates matching rows', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    const updated = await repo.updateMany(
      { name: 'Alice Updated' } as any,
      e => e.eq('email', 'a@test.com'),
    )

    expect(updated).toHaveLength(1)
    expect(updated[0]!.name).toBe('Alice Updated')
  })
})

describe('CRUD - updateOne', () => {
  it('updates and returns single row', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    const updated = await repo.updateOne(
      { name: 'Alice V2' } as any,
      e => e.eq('email', 'a@test.com'),
    )

    expect(updated).not.toBeNull()
    expect(updated!.name).toBe('Alice V2')
  })

  it('returns null when no match', async () => {
    const repo = db.repo(usersTable)
    const result = await repo.updateOne({ name: 'Nobody' } as any, e => e.eq('id', 999999))

    expect(result).toBeNull()
  })
})

describe('CRUD - deleteMany', () => {
  it('soft-deletes rows (because of softDelete trait)', async () => {
    const repo = db.repo(usersTable)
    const user = await repo.insertOne({ name: 'Alice', email: 'a@test.com' })

    const deleted = await repo.deleteMany(e => e.eq('id', user.id))

    expect(deleted).toHaveLength(1)
    expect((deleted[0] as any).deletedAt).not.toBeNull()

    // Soft-deleted rows should not appear in findMany
    const remaining = await repo.findMany()

    expect(remaining).toHaveLength(0)
  })
})

describe('CRUD - findOrCreate', () => {
  it('creates new row when not exists', async () => {
    const repo = db.repo(usersTable)
    const user = await repo.findOrCreate(
      { name: 'Alice', email: 'a@test.com' },
      ['email'],
    )

    expect(user.name).toBe('Alice')
  })

  it('returns existing row on conflict', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    const user = await repo.findOrCreate(
      { name: 'Alice Different', email: 'a@test.com' },
      ['email'],
    )

    expect(user.email).toBe('a@test.com')
  })
})

describe('CRUD - count', () => {
  it('counts all rows', async () => {
    const repo = db.repo(usersTable)

    await repo.insertMany([
      { name: 'A', email: 'a@test.com' },
      { name: 'B', email: 'b@test.com' },
    ])
    const count = await repo.count()

    expect(count).toBe(2)
  })

  it('counts with filter', async () => {
    const repo = db.repo(usersTable)

    await repo.insertMany([
      { name: 'Alice', email: 'a@test.com', age: 30 },
      { name: 'Bob', email: 'b@test.com', age: 20 },
    ])
    const count = await repo.count(e => e.gt('age', 25))

    expect(count).toBe(1)
  })
})

describe('CRUD - exists', () => {
  it('returns true when match exists', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    const result = await repo.exists(e => e.eq('email', 'a@test.com'))

    expect(result).toBe(true)
  })

  it('returns false when no match', async () => {
    const repo = db.repo(usersTable)
    const result = await repo.exists(e => e.eq('email', 'ghost@test.com'))

    expect(result).toBe(false)
  })
})
