import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { InMemoryCache, ORM } from '../src'
import { cleanupTables, createTestTable, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Query Caching', () => {
  let cache: InMemoryCache
  const orm = new ORM()

  beforeAll(async () => {
    cache = new InMemoryCache(60000)
    await setupTestDatabase({ cache, autoMigrate: false, orm })
  })

  afterAll(async () => {
    cache.stopCleanup()
    await teardownTestDatabase({ orm })
  })

  describe('InMemoryCache', () => {
    test('should cache query results', async () => {
      const User = orm.entity('cache_test_users', {
        name: orm.string(),
        email: orm.string().unique(),
        age: orm.number(),
      }).build()

      await createTestTable(User, orm)

      const users = orm.repo(User)

      await users.create({ name: 'Alice', email: 'alice@test.com', age: 30 })
      await users.create({ name: 'Bob', email: 'bob@test.com', age: 25 })

      const start1 = performance.now()
      const result1 = await users.query().cache(60).execute()
      const duration1 = performance.now() - start1

      const start2 = performance.now()
      const result2 = await users.query().cache(60).execute()
      const duration2 = performance.now() - start2

      expect(result1.length).toBe(result2.length)
      expect(duration2).toBeLessThan(duration1 * 0.5) // Cache should be much faster
      expect(cache.size()).toBeGreaterThan(0)

      await cleanupTables(orm, 'cache_test_users')
    })

    test('should throw error if cache not configured', async () => {
      await orm.disconnect()
      await setupTestDatabase({ autoMigrate: false, orm })

      const User = orm.entity('cache_test_no_adapter', {
        name: orm.string(),
      }).build()

      await createTestTable(User, orm)

      const users = orm.repo(User)

      expect(async () => {
        await users.query().cache(60).execute()
      }).toThrow('Cache adapter not configured')

      await cleanupTables(orm, 'cache_test_no_adapter')
      await orm.disconnect()
      await setupTestDatabase({ cache, autoMigrate: false, orm })
    })

    test('should validate cache TTL', async () => {
      const User = orm.entity('cache_test_ttl', {
        name: orm.string(),
      }).build()

      await createTestTable(User, orm)

      const users = orm.repo(User)

      expect(() => {
        users.query().cache(0)
      }).toThrow('Invalid cache TTL')

      expect(() => {
        users.query().cache(-1)
      }).toThrow('Invalid cache TTL')

      await cleanupTables(orm, 'cache_test_ttl')
    })

    test('should handle different cache keys', async () => {
      const User = orm.entity('cache_test_keys', {
        name: orm.string(),
        age: orm.number(),
      }).build()

      await createTestTable(User, orm)

      const users = orm.repo(User)

      await users.create({ name: 'Alice', age: 30 })
      await users.create({ name: 'Bob', age: 25 })

      const result1 = await users.query().whereEquals('age', 30).cache(60).execute()
      const result2 = await users.query().whereEquals('age', 25).cache(60).execute()

      expect(result1.length).toBe(1)
      expect(result2.length).toBe(1)
      expect(result1[0]!.name).toBe('Alice')
      expect(result2[0]!.name).toBe('Bob')

      await cleanupTables(orm, 'cache_test_keys')
    })
  })
})
