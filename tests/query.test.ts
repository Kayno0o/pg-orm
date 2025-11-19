import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import { cleanupTables, setupTestDatabase, teardownTestDatabase, testData } from './setup'

const User = orm.entity('test_query_users', {
  name: orm.string(),
  email: orm.string(),
  age: orm.number().nullable(),
  role: orm.enum(['admin', 'user', 'moderator'] as const),
  tags: orm.array('string'),
  metadata: orm.jsonb().nullable(),
}).build()

describe('Query Builder', () => {
  let users: ReturnType<typeof orm.repo<typeof User.schema>>

  beforeAll(async () => {
    // Register repository before connecting to enable auto-migration
    users = orm.repo(User)
    await setupTestDatabase()
  })

  afterAll(async () => {
    await cleanupTables('test_query_users')
    await teardownTestDatabase()
  })

  describe('Where Clauses', () => {
    test('should filter with equality', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'alice@example.com', name: 'Alice' })
      await users.create({ ...testData.user.valid(), email: 'bob@example.com', name: 'Bob' })

      const results = await users.query()
        .where('name', '=', 'Alice')
        .execute()

      expect(results.length).toBe(1)
      expect(results[0]?.name).toBe('Alice')
    })

    test('should filter with greater than', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'young@example.com', age: 20 })
      await users.create({ ...testData.user.valid(), email: 'old@example.com', age: 40 })

      const results = await users.query()
        .where('age', '>', 25)
        .execute()

      expect(results.length).toBe(1)
      expect(results[0]?.age).toBe(40)
    })

    test('should filter with greater than or equal', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'user1@example.com', age: 25 })
      await users.create({ ...testData.user.valid(), email: 'user2@example.com', age: 30 })
      await users.create({ ...testData.user.valid(), email: 'user3@example.com', age: 20 })

      const results = await users.query()
        .where('age', '>=', 25)
        .execute()

      expect(results.length).toBe(2)
    })

    test('should filter with less than', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'young1@example.com', age: 18 })
      await users.create({ ...testData.user.valid(), email: 'young2@example.com', age: 22 })
      await users.create({ ...testData.user.valid(), email: 'old@example.com', age: 40 })

      const results = await users.query()
        .where('age', '<', 25)
        .execute()

      expect(results.length).toBe(2)
    })

    test('should filter with IN operator', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'admin@example.com', role: 'admin' })
      await users.create({ ...testData.user.valid(), email: 'mod@example.com', role: 'moderator' })
      await users.create({ ...testData.user.valid(), email: 'user@example.com', role: 'user' })

      const results = await users.query()
        .whereIn('role', ['admin', 'moderator'])
        .execute()

      expect(results.length).toBe(2)
      expect(results.every(u => u.role === 'admin' || u.role === 'moderator')).toBe(true)
    })

    test('should filter with NOT IN operator', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'admin@example.com', role: 'admin' })
      await users.create({ ...testData.user.valid(), email: 'user1@example.com', role: 'user' })
      await users.create({ ...testData.user.valid(), email: 'user2@example.com', role: 'user' })

      const results = await users.query()
        .whereNotIn('role', ['admin'])
        .execute()

      expect(results.length).toBe(2)
      expect(results.every(u => u.role === 'user')).toBe(true)
    })

    test('should filter with NULL checks', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'withnull@example.com', age: null })
      await users.create({ ...testData.user.valid(), email: 'withage@example.com', age: 25 })

      const nullResults = await users.query()
        .whereNull('age')
        .execute()

      expect(nullResults.length).toBe(1)
      expect(nullResults[0]?.age).toBeNull()

      const notNullResults = await users.query()
        .whereNotNull('age')
        .execute()

      expect(notNullResults.length).toBe(1)
      expect(notNullResults[0]?.age).toBe(25)
    })

    test('should chain multiple where clauses', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'user1@example.com', role: 'admin', age: 30 })
      await users.create({ ...testData.user.valid(), email: 'user2@example.com', role: 'admin', age: 20 })
      await users.create({ ...testData.user.valid(), email: 'user3@example.com', role: 'user', age: 30 })

      const results = await users.query()
        .where('role', '=', 'admin')
        .where('age', '>=', 25)
        .execute()

      expect(results.length).toBe(1)
      expect(results[0]?.role).toBe('admin')
      expect(results[0]?.age).toBe(30)
    })
  })

  describe('Order By', () => {
    test('should order by ascending', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'c@example.com', name: 'Charlie' })
      await users.create({ ...testData.user.valid(), email: 'a@example.com', name: 'Alice' })
      await users.create({ ...testData.user.valid(), email: 'b@example.com', name: 'Bob' })

      const results = await users.query()
        .orderBy('name', 'ASC')
        .execute()

      expect(results[0]?.name).toBe('Alice')
      expect(results[1]?.name).toBe('Bob')
      expect(results[2]?.name).toBe('Charlie')
    })

    test('should order by descending', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'c@example.com', name: 'Charlie' })
      await users.create({ ...testData.user.valid(), email: 'a@example.com', name: 'Alice' })
      await users.create({ ...testData.user.valid(), email: 'b@example.com', name: 'Bob' })

      const results = await users.query()
        .orderBy('name', 'DESC')
        .execute()

      expect(results[0]?.name).toBe('Charlie')
      expect(results[1]?.name).toBe('Bob')
      expect(results[2]?.name).toBe('Alice')
    })
  })

  describe('Limit and Offset', () => {
    test('should limit results', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      for (let i = 0; i < 10; i++) {
        await users.create({ ...testData.user.valid(), email: `user${i}@example.com` })
      }

      const results = await users.query()
        .limit(5)
        .execute()

      expect(results.length).toBe(5)
    })

    test('should offset results', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      for (let i = 0; i < 10; i++) {
        await users.create({
          ...testData.user.valid(),
          email: `user${i}@example.com`,
          name: `User ${i}`,
        })
      }

      const results = await users.query()
        .orderBy('name', 'ASC')
        .limit(5)
        .offset(5)
        .execute()

      expect(results.length).toBe(5)
      // Should skip first 5
      expect(results[0]?.name).toBe('User 5')
    })
  })

  describe('Helper Methods', () => {
    test('should get latest record', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'first@example.com' })

      await new Promise(resolve => setTimeout(resolve, 10))
      const user2 = await users.create({ ...testData.user.valid(), email: 'second@example.com' })

      const latest = await users.query().latest('id')

      expect(latest).not.toBeNull()
      expect(latest?.id).toBe(user2.id)
    })

    test('should get oldest record', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      const user1 = await users.create({ ...testData.user.valid(), email: 'first@example.com' })

      await new Promise(resolve => setTimeout(resolve, 10))
      await users.create({ ...testData.user.valid(), email: 'second@example.com' })

      const oldest = await users.query().oldest('id')

      expect(oldest).not.toBeNull()
      expect(oldest?.id).toBe(user1.id)
    })

    test('should get random records', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      for (let i = 0; i < 10; i++) {
        await users.create({ ...testData.user.valid(), email: `rand${i}@example.com` })
      }

      const random = await users.query().random(3)

      expect(random.length).toBe(3)
      // All should have different IDs
      const ids = new Set(random.map(u => u.id))

      expect(ids.size).toBe(3)
    })

    test('should count records', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      for (let i = 0; i < 7; i++) {
        await users.create({ ...testData.user.valid(), email: `count${i}@example.com` })
      }

      const count = await users.query().count()

      expect(count).toBe(7)
    })

    test('should count with where clause', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({ ...testData.user.valid(), email: 'admin1@example.com', role: 'admin' })
      await users.create({ ...testData.user.valid(), email: 'admin2@example.com', role: 'admin' })
      await users.create({ ...testData.user.valid(), email: 'user1@example.com', role: 'user' })

      const count = await users.query()
        .where('role', '=', 'admin')
        .count()

      expect(count).toBe(2)
    })
  })

  describe('Complex Queries', () => {
    test('should handle complex multi-condition queries', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_query_users`

      await users.create({
        ...testData.user.valid(),
        email: 'user1@example.com',
        name: 'Alice',
        role: 'admin',
        age: 30,
      })
      await users.create({
        ...testData.user.valid(),
        email: 'user2@example.com',
        name: 'Bob',
        role: 'admin',
        age: 25,
      })
      await users.create({
        ...testData.user.valid(),
        email: 'user3@example.com',
        name: 'Charlie',
        role: 'user',
        age: 35,
      })

      const results = await users.query()
        .where('role', '=', 'admin')
        .where('age', '>=', 28)
        .orderBy('name', 'ASC')
        .limit(10)
        .execute()

      expect(results.length).toBe(1)
      expect(results[0]?.name).toBe('Alice')
    })
  })
})
