import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { MultipleRowsError } from '../../src/index'
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
  it('inserts and returns the primary key', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.write.insertOne({ name: 'Alice', email: 'alice@test.com' })

    expect(userId).toBeDefined()

    const user = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', userId)))

    expect(user.name).toBe('Alice')
    expect(user.email).toBe('alice@test.com')
  })

  it('auto-sets createdAt/updatedAt via timestamps trait', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.write.insertOne({ name: 'Bob', email: 'bob@test.com' })
    const user = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', userId)))

    expect(user.createdAt).toBeInstanceOf(Date)
    expect(user.updatedAt).toBeInstanceOf(Date)
  })

  it('inserts with nullable field', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.write.insertOne({ name: 'Charlie', email: 'charlie@test.com', age: 30 })
    const user = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', userId)))

    expect(user.age).toBe(30)
  })

  it('inserts with null nullable field', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.write.insertOne({ name: 'Dave', email: 'dave@test.com', age: null })
    const user = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', userId)))

    expect(user.age).toBeNull()
  })
})

describe('CRUD - insertMany', () => {
  it('inserts multiple rows', async () => {
    const repo = db.repo(usersTable)
    const userIds = await repo.write.insertMany([
      { name: 'A', email: 'a@test.com' },
      { name: 'B', email: 'b@test.com' },
      { name: 'C', email: 'c@test.com' },
    ])

    expect(userIds).toHaveLength(3)

    const firstUser = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', userIds[0]!)))

    expect(firstUser.name).toBe('A')
  })

  it('returns empty array for empty input', async () => {
    const repo = db.repo(usersTable)
    const result = await repo.write.insertMany([])

    expect(result).toEqual([])
  })
})

describe('CRUD - findMany', () => {
  it('finds all rows', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertMany([
      { name: 'A', email: 'a@test.com' },
      { name: 'B', email: 'b@test.com' },
    ])
    const users = await repo.read.findMany()

    expect(users).toHaveLength(2)
  })

  it('filters with where', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertMany([
      { name: 'Alice', email: 'alice@test.com' },
      { name: 'Bob', email: 'bob@test.com' },
    ])
    const users = await repo.read.findMany(q => q.where(e => e.eq('name', 'Alice')))

    expect(users).toHaveLength(1)
    expect(users[0]!.name).toBe('Alice')
  })

  it('orders results', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertMany([
      { name: 'Charlie', email: 'c@test.com' },
      { name: 'Alice', email: 'a@test.com' },
      { name: 'Bob', email: 'b@test.com' },
    ])
    const users = await repo.read.findMany(q => q.orderBy('name', 'asc'))

    expect(users[0]!.name).toBe('Alice')
    expect(users[2]!.name).toBe('Charlie')
  })

  it('limits results', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertMany([
      { name: 'A', email: 'a@test.com' },
      { name: 'B', email: 'b@test.com' },
      { name: 'C', email: 'c@test.com' },
    ])
    const users = await repo.read.findMany(q => q.limit(2))

    expect(users).toHaveLength(2)
  })

  it('picks specific columns', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
    const users = await repo.read.findMany(q => q.pick('id', 'name'))

    expect(users[0]).toHaveProperty('name')
    expect(users[0]).toHaveProperty('id')
  })
})

describe('CRUD - findOne', () => {
  it('returns first matching row', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
    const user = await repo.read.findOne(q => q.where(e => e.eq('name', 'Alice')))

    expect(user).not.toBeNull()
    expect(user!.name).toBe('Alice')
  })

  it('returns null when not found', async () => {
    const repo = db.repo(usersTable)
    const user = await repo.read.findOne(q => q.where(e => e.eq('name', 'Ghost')))

    expect(user).toBeNull()
  })
})

describe('CRUD - findById', () => {
  it('finds row by id', async () => {
    const repo = db.repo(usersTable)
    const insertedId = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
    const found = await repo.read.findById(insertedId)

    expect(found).not.toBeNull()
    expect(found!.id).toBe(insertedId)
  })

  it('returns null for missing id', async () => {
    const repo = db.repo(usersTable)
    const found = await repo.read.findById(999999)

    expect(found).toBeNull()
  })
})

describe('CRUD - updateMany', () => {
  it('updates matching rows', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
    const updated = await repo.write.updateMany(
      { name: 'Alice Updated' },
      e => e.eq('email', 'a@test.com'),
      { full: true },
    )

    expect(updated).toHaveLength(1)
    expect(updated[0]!.name).toBe('Alice Updated')
  })
})

describe('CRUD - updateOne', () => {
  it('updates and returns single row', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
    const updated = await repo.write.updateOne(
      { name: 'Alice V2' },
      e => e.eq('email', 'a@test.com'),
      { full: true },
    )

    expect(updated).not.toBeNull()
    expect(updated!.name).toBe('Alice V2')
  })

  it('returns null when no match', async () => {
    const repo = db.repo(usersTable)
    const result = await repo.write.updateOne({ name: 'Nobody' }, e => e.eq('id', 999999))

    expect(result).toBeNull()
  })

  it('changes only the first of several matching rows, by primary key', async () => {
    const repo = db.repo(usersTable)
    const [first, second] = await repo.write.insertMany([
      { name: 'Twin', email: 'twin1@test.com', age: 5 },
      { name: 'Twin', email: 'twin2@test.com', age: 5 },
    ])

    expect(await repo.write.updateOne({ age: 9 }, { age: 5 })).toBe(first!)
    expect((await repo.read.findById(second!))?.age).toBe(5)
  })

  it('reaches a trashed row with withTrashed, and passes over it without', async () => {
    const repo = db.repo(usersTable)
    const [trashed, live] = await repo.write.insertMany([
      { name: 'Gone', email: 'gone@test.com', age: 3 },
      { name: 'Here', email: 'here@test.com', age: 3 },
    ])

    await repo.write.deleteById(trashed!)

    expect(await repo.write.updateOne({ name: 'X' }, { age: 3 })).toBe(live!)
    expect(await repo.write.updateOne({ name: 'Y' }, { age: 3 }, { withTrashed: true })).toBe(trashed!)
  })
})

describe('CRUD - deleteOne', () => {
  it('deletes only the first of several matching rows, passing over trashed ones', async () => {
    const repo = db.repo(usersTable)
    const [first, second, third] = await repo.write.insertMany([
      { name: 'Twin', email: 'twin1@test.com', age: 5 },
      { name: 'Twin', email: 'twin2@test.com', age: 5 },
      { name: 'Twin', email: 'twin3@test.com', age: 5 },
    ])

    expect(await repo.write.deleteOne({ age: 5 })).toBe(first!)
    expect(await repo.write.deleteOne({ age: 5 })).toBe(second!)
    expect(await repo.read.count({ age: 5 })).toBe(1)
    expect((await repo.read.findById(third!))?.age).toBe(5)
  })
})

describe('CRUD - updateOne/deleteOne with onMany: \'throw\'', () => {
  async function seed() {
    const repo = db.repo(usersTable)
    const [first, second, third] = await repo.write.insertMany([
      { name: 'Twin', email: 'twin1@test.com', age: 5 },
      { name: 'Twin', email: 'twin2@test.com', age: 5 },
      { name: 'Solo', email: 'solo@test.com', age: 7 },
    ])

    return { repo, first: first!, second: second!, third: third! }
  }

  it('throws and changes nothing when several rows match', async () => {
    const { repo } = await seed()

    await expect(repo.write.updateOne({ age: 9 }, { age: 5 }, { onMany: 'throw' })).rejects.toBeInstanceOf(MultipleRowsError)
    await expect(repo.write.deleteOne({ age: 5 }, { onMany: 'throw' })).rejects.toBeInstanceOf(MultipleRowsError)
    expect(await repo.read.count({ age: 5 })).toBe(2)
  })

  it('changes the one row that matches, and answers null when none does', async () => {
    const { repo, third } = await seed()

    expect(await repo.write.updateOne({ age: 8 }, { age: 7 }, { onMany: 'throw' })).toBe(third)
    expect(await repo.write.updateOne({ age: 1 }, { age: 99 }, { onMany: 'throw' })).toBeNull()
    expect(await repo.write.deleteOne({ age: 8 }, { onMany: 'throw' })).toBe(third)
    expect(await repo.write.deleteOne({ age: 8 }, { onMany: 'throw' })).toBeNull()
  })

  it('counts only live rows on a soft-delete table, unless withTrashed', async () => {
    const { repo, first, second } = await seed()

    await repo.write.deleteById(first)

    await expect(repo.write.updateOne({ age: 5 }, { age: 5 }, { onMany: 'throw', withTrashed: true })).rejects.toBeInstanceOf(MultipleRowsError)
    expect(await repo.write.deleteOne({ age: 5 }, { onMany: 'throw' })).toBe(second)
  })
})

describe('CRUD - deleteMany', () => {
  it('soft-deletes rows (because of softDelete trait)', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' })

    const deleted = await repo.write.deleteMany(e => e.eq('id', userId), { full: true })

    expect(deleted).toHaveLength(1)
    expect(deleted[0]!.deletedAt).not.toBeNull()

    // Soft-deleted rows should not appear in findMany
    const remaining = await repo.read.findMany()

    expect(remaining).toHaveLength(0)
  })
})

describe('CRUD - findOrCreate', () => {
  it('creates new row when not exists', async () => {
    const repo = db.repo(usersTable)
    const user = await repo.write.findOrCreate(
      { name: 'Alice', email: 'a@test.com' },
      ['email'],
      { full: true },
    )

    expect(user.name).toBe('Alice')
  })

  it('returns existing row on conflict', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
    const user = await repo.write.findOrCreate(
      { name: 'Alice Different', email: 'a@test.com' },
      ['email'],
      { full: true },
    )

    expect(user.email).toBe('a@test.com')
  })
})

describe('CRUD - count', () => {
  it('counts all rows', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertMany([
      { name: 'A', email: 'a@test.com' },
      { name: 'B', email: 'b@test.com' },
    ])
    const count = await repo.read.count()

    expect(count).toBe(2)
  })

  it('counts with filter', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertMany([
      { name: 'Alice', email: 'a@test.com', age: 30 },
      { name: 'Bob', email: 'b@test.com', age: 20 },
    ])
    const count = await repo.read.count(e => e.gt('age', 25))

    expect(count).toBe(1)
  })
})

describe('CRUD - exists', () => {
  it('returns true when match exists', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
    const result = await repo.read.exists(e => e.eq('email', 'a@test.com'))

    expect(result).toBe(true)
  })

  it('returns false when no match', async () => {
    const repo = db.repo(usersTable)
    const result = await repo.read.exists(e => e.eq('email', 'ghost@test.com'))

    expect(result).toBe(false)
  })
})
