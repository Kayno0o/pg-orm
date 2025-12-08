import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import {
  createTestTable,
  createTxRepo,
  getTestSchema,
  runInTransaction,
  setupTestDatabase,
  teardownTestDatabase,
} from './setup'

// Define entities at module level for auto-migration
const User = orm.entity('test_bulk_users', {
  name: orm.string(),
  email: orm.string().unique(),
  role: orm.enum(['admin', 'user'] as const).default('user'),
}).build()

const Product = orm.entity('test_bulk_products', {
  name: orm.string(),
  email: orm.string(),
  slug: orm.string(),
})
  .beforeCreate((data) => {
    data.email = data.email.toLowerCase()
  })
  .afterCreate(async () => {
    // Hook executes for each item
  })
  .build()

const Article = orm.entity('test_bulk_articles', {
  title: orm.string().minLength(5),
  content: orm.string().minLength(10),
  views: orm.number().min(0).default(0),
}).build()

const Tag = orm.entity('test_bulk_tags', {
  name: orm.string(),
  category: orm.string(),
}).build()

const Benchmark = orm.entity('test_bulk_benchmark', {
  name: orm.string(),
  value: orm.number(),
  timestamp: orm.timestamp().default('NOW()'),
}).build()

describe('Bulk Operations', () => {
  const schema = getTestSchema()

  beforeAll(async () => {
    await setupTestDatabase({ schema })

    // Create tables manually for schema-isolated tests
    await createTestTable(User)
    await createTestTable(Product)
    await createTestTable(Article)
    await createTestTable(Tag)
    await createTestTable(Benchmark)

    // Register repos
    orm.repo(User)
    orm.repo(Product)
    orm.repo(Article)
    orm.repo(Tag)
    orm.repo(Benchmark)
  })

  afterAll(async () => {
    await teardownTestDatabase({ schema })
  })

  describe('Bulk Insert with createMany', () => {

    test('should insert 100+ records efficiently', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const startTime = Date.now()

        const userData = Array.from({ length: 150 }, (_, i) => ({
          name: `User ${i}`,
          email: `user${i}_${Date.now()}@example.com`,
          role: i % 10 === 0 ? ('admin' as const) : ('user' as const),
        }))

        const created = await users.createMany(userData)

        const duration = Date.now() - startTime

        expect(created.length).toBe(150)
        expect(created.every(u => u.id > 0)).toBe(true)
        expect(duration).toBeLessThan(5000) // Should be fast (< 5 seconds)

        // Verify all were inserted
        const count = await users.count()

        expect(count).toBe(150)
      })
    })

    test('should handle empty array', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const created = await users.createMany([])

        expect(created).toEqual([])
      })
    })

    test('should handle duplicate key errors in batch', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const userData = [
          { name: 'User A', email: 'duplicate@example.com', role: 'user' as const },
          { name: 'User B', email: 'duplicate@example.com', role: 'user' as const }, // Duplicate email
        ]

        expect(users.createMany(userData)).rejects.toThrow()
      })
    })

    test('should preserve insertion order', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const userData = [
          { name: 'First', email: `first_${Date.now()}@example.com`, role: 'admin' as const },
          { name: 'Second', email: `second_${Date.now()}@example.com`, role: 'user' as const },
          { name: 'Third', email: `third_${Date.now()}@example.com`, role: 'user' as const },
        ]

        const created = await users.createMany(userData)

        expect(created[0]!.name).toBe('First')
        expect(created[1]!.name).toBe('Second')
        expect(created[2]!.name).toBe('Third')

        // IDs should be sequential
        expect(created[1]!.id).toBeGreaterThan(created[0]!.id)
        expect(created[2]!.id).toBeGreaterThan(created[1]!.id)
      })
    })
  })

  describe('Bulk Insert with Hooks', () => {

    test('should execute beforeCreate hooks for each item', async () => {
      await runInTransaction(async (tx) => {
        const products = createTxRepo(Product, tx)
        const productData = [
          { name: 'Product 1', email: 'PROD1@EXAMPLE.COM', slug: 'product-1' },
          { name: 'Product 2', email: 'PROD2@EXAMPLE.COM', slug: 'product-2' },
          { name: 'Product 3', email: 'PROD3@EXAMPLE.COM', slug: 'product-3' },
        ]

        const created = await products.createMany(productData)

        // Verify emails were lowercased by beforeCreate hook
        expect(created[0]!.email).toBe('prod1@example.com')
        expect(created[1]!.email).toBe('prod2@example.com')
        expect(created[2]!.email).toBe('prod3@example.com')
      })
    })

    test('should execute afterCreate hooks for each item', async () => {
      await runInTransaction(async (tx) => {
        const products = createTxRepo(Product, tx)
        const productData = [
          { name: 'Product A', email: 'proda@example.com', slug: 'product-a' },
          { name: 'Product B', email: 'prodb@example.com', slug: 'product-b' },
        ]

        const created = await products.createMany(productData)

        // If we get here, afterCreate hooks executed without error
        expect(created.length).toBe(2)
      })
    })
  })

  describe('Bulk Insert with Validation', () => {

    test('should validate all items before insertion', async () => {
      await runInTransaction(async (tx) => {
        const articles = createTxRepo(Article, tx)
        const articleData = [
          { title: 'Valid Title 1', content: 'Valid content here', views: 100 },
          { title: 'Bad', content: 'Too short' }, // Invalid: title too short
          { title: 'Valid Title 2', content: 'Valid content here', views: 50 },
        ]

        expect(articles.createMany(articleData)).rejects.toThrow()
      })
    })

    test('should insert only when all items are valid', async () => {
      await runInTransaction(async (tx) => {
        const articles = createTxRepo(Article, tx)
        const articleData = [
          { title: 'Valid Title 1', content: 'Valid content here', views: 100 },
          { title: 'Valid Title 2', content: 'Another valid content', views: 50 },
          { title: 'Valid Title 3', content: 'More valid content', views: 75 },
        ]

        const created = await articles.createMany(articleData)

        expect(created.length).toBe(3)
        expect(created.every(a => a.id > 0)).toBe(true)
      })
    })
  })

  describe('Bulk Delete with deleteMany', () => {

    test('should delete multiple records by IDs', async () => {
      await runInTransaction(async (tx) => {
        const tags = createTxRepo(Tag, tx)
        const tagData = [
          { name: 'Tag 1', category: 'tech' },
          { name: 'Tag 2', category: 'tech' },
          { name: 'Tag 3', category: 'news' },
          { name: 'Tag 4', category: 'news' },
        ]

        const created = await tags.createMany(tagData)
        const idsToDelete = [created[0]!.id, created[2]!.id]

        await tags.deleteMany(idsToDelete)

        const remaining = await tags.findAll()

        expect(remaining.length).toBe(2)
        expect(remaining.map(t => t.id)).toContain(created[1]!.id)
        expect(remaining.map(t => t.id)).toContain(created[3]!.id)
        expect(remaining.map(t => t.id)).not.toContain(created[0]!.id)
        expect(remaining.map(t => t.id)).not.toContain(created[2]!.id)
      })
    })

    test('should handle empty array in deleteMany', async () => {
      await runInTransaction(async (tx) => {
        const tags = createTxRepo(Tag, tx)

        await tags.deleteMany([])
        // Should not throw - if we reach here, test passes
      })
    })

    test('should handle non-existent IDs gracefully', async () => {
      await runInTransaction(async (tx) => {
        const tags = createTxRepo(Tag, tx)

        await tags.deleteMany([99999, 99998])
        // Should not throw - if we reach here, test passes
      })
    })
  })

  describe('Performance Benchmarks', () => {

    test('should insert 1000 records in reasonable time', async () => {
      await runInTransaction(async (tx) => {
        const benchmark = createTxRepo(Benchmark, tx)
        const startTime = Date.now()

        const data = Array.from({ length: 1000 }, (_, i) => ({
          name: `Record ${i}`,
          value: Math.random() * 1000,
        }))

        const created = await benchmark.createMany(data)
        const duration = Date.now() - startTime

        expect(created.length).toBe(1000)
        expect(duration).toBeLessThan(10000) // Should complete in < 10 seconds
        console.log(`Bulk insert of 1000 records took ${duration}ms`)
      })
    })

    test('should compare bulk vs individual inserts', async () => {
      await runInTransaction(async (tx) => {
        const benchmark = createTxRepo(Benchmark, tx)
        const data = Array.from({ length: 50 }, (_, i) => ({
          name: `Single ${i}`,
          value: i,
        }))

        // Individual inserts
        const singleStart = Date.now()

        for (const item of data.slice(0, 50)) {
          await benchmark.create(item)
        }
        const singleDuration = Date.now() - singleStart

        // Bulk insert
        const bulkData = Array.from({ length: 50 }, (_, i) => ({
          name: `Bulk ${i}`,
          value: i,
        }))

        const bulkStart = Date.now()

        await benchmark.createMany(bulkData)
        const bulkDuration = Date.now() - bulkStart

        console.log(`Individual inserts (50): ${singleDuration}ms`)
        console.log(`Bulk insert (50): ${bulkDuration}ms`)
        console.log(`Bulk is ${(singleDuration / bulkDuration).toFixed(2)}x faster`)

        // Bulk should be significantly faster
        expect(bulkDuration).toBeLessThan(singleDuration)
      })
    })
  })
})
