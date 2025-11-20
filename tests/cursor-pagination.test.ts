import type { InferEntity } from '../src'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import { cleanupTables, createTestTable, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Cursor-Based Pagination', () => {
  const Article = orm.entity('test_cursor_articles', {
    title: orm.string(),
    category: orm.string(),
    views: orm.number().default(0),
    published: orm.boolean().default(false),
  }).build()

  let articles: ReturnType<typeof orm.repo<typeof Article.schema>>

  beforeAll(async () => {
    articles = orm.repo(Article)
    await setupTestDatabase()

    // Seed test data
    const seedData = Array.from({ length: 100 }, (_, i) => ({
      title: `Article ${i + 1}`,
      category: i % 3 === 0 ? 'tech' : i % 3 === 1 ? 'news' : 'opinion',
      views: Math.floor(Math.random() * 1000),
      published: i % 2 === 0,
    }))

    await articles.createMany(seedData)
  })

  afterAll(async () => {
    await cleanupTables('test_cursor_articles')
    await teardownTestDatabase()
  })

  describe('Basic Cursor Pagination', () => {
    test('should paginate with cursor (first page)', async () => {
      const page1 = await articles.paginateCursor({
        pageSize: 10,
      })

      expect(page1.data.length).toBe(10)
      expect(page1.hasMore).toBe(true)
      expect(page1.nextCursor).toBeGreaterThan(0)
      expect(page1.nextCursor).toBe(page1.data[page1.data.length - 1]!.id)
    })

    test('should paginate with cursor (second page)', async () => {
      const page1 = await articles.paginateCursor({
        pageSize: 10,
      })

      const page2 = await articles.paginateCursor({
        after: page1.nextCursor,
        pageSize: 10,
      })

      expect(page2.data.length).toBe(10)
      expect(page2.hasMore).toBe(true)
      expect(page2.nextCursor).toBeGreaterThan(page1.nextCursor!)

      // Ensure no overlap
      const page1Ids = new Set(page1.data.map(a => a.id))
      const page2Ids = page2.data.map(a => a.id)

      for (const id of page2Ids) {
        expect(page1Ids.has(id)).toBe(false)
      }
    })

    test('should paginate through all pages', async () => {
      const allPages: InferEntity<typeof articles['schema']>[] = []
      let cursor: number | undefined

      while (true) {
        const page = await articles.paginateCursor({
          after: cursor,
          pageSize: 15,
        })

        allPages.push(...page.data)

        if (!page.hasMore) {
          expect(page.nextCursor).toBeUndefined()

          break
        }

        cursor = page.nextCursor
      }

      // Should have paginated through all 100 records
      expect(allPages.length).toBe(100)

      // All IDs should be unique
      const ids = allPages.map(a => a.id)
      const uniqueIds = new Set(ids)

      expect(uniqueIds.size).toBe(100)
    })

    test('should handle last page correctly', async () => {
      const allArticles = await articles.findAll()
      const lastArticleId = allArticles[allArticles.length - 5]!.id

      const lastPage = await articles.paginateCursor({
        after: lastArticleId,
        pageSize: 10,
      })

      expect(lastPage.data.length).toBeLessThanOrEqual(10)
      expect(lastPage.hasMore).toBe(false)
      expect(lastPage.nextCursor).toBeUndefined()
    })
  })

  describe('Cursor Pagination with WHERE Conditions', () => {
    test('should paginate with WHERE filter', async () => {
      const page1 = await articles.paginateCursor({
        pageSize: 10,
        where: { category: 'tech' },
      })

      expect(page1.data.length).toBeLessThanOrEqual(10)
      expect(page1.data.every(a => a.category === 'tech')).toBe(true)

      if (page1.hasMore) {
        const page2 = await articles.paginateCursor({
          after: page1.nextCursor,
          pageSize: 10,
          where: { category: 'tech' },
        })

        expect(page2.data.every(a => a.category === 'tech')).toBe(true)

        // No overlap
        const page1Ids = new Set(page1.data.map(a => a.id))

        expect(page2.data.every(a => !page1Ids.has(a.id))).toBe(true)
      }
    })

    test('should paginate with boolean WHERE filter', async () => {
      const page1 = await articles.paginateCursor({
        pageSize: 20,
        where: { published: true },
      })

      expect(page1.data.every(a => a.published === true)).toBe(true)
    })

    test('should paginate with multiple WHERE conditions', async () => {
      const page1 = await articles.paginateCursor({
        pageSize: 10,
        where: {
          category: 'news',
          published: true,
        },
      })

      expect(page1.data.every(a => a.category === 'news' && a.published === true)).toBe(true)
    })
  })

  describe('hasMore Flag Accuracy', () => {
    test('should set hasMore to true when more records exist', async () => {
      const page = await articles.paginateCursor({
        pageSize: 10,
      })

      expect(page.hasMore).toBe(true)
    })

    test('should set hasMore to false on last page', async () => {
      const allArticles = await articles.findAll()
      const lastId = allArticles[allArticles.length - 3]!.id

      const page = await articles.paginateCursor({
        after: lastId,
        pageSize: 10,
      })

      expect(page.hasMore).toBe(false)
    })

    test('should set hasMore correctly when exactly pageSize records remain', async () => {
      // Get exact cursor position
      const firstPage = await articles.paginateCursor({
        pageSize: 10,
      })

      // This should fetch exactly 10 more, with 80 remaining
      const secondPage = await articles.paginateCursor({
        after: firstPage.nextCursor,
        pageSize: 10,
      })

      expect(secondPage.data.length).toBe(10)
      expect(secondPage.hasMore).toBe(true)
    })
  })

  describe('nextCursor Correctness', () => {
    test('should set nextCursor to last item ID', async () => {
      const page = await articles.paginateCursor({
        pageSize: 10,
      })

      const lastItemId = page.data[page.data.length - 1]!.id

      expect(page.nextCursor).toBe(lastItemId)
    })

    test('should not set nextCursor when no more records', async () => {
      const allArticles = await articles.findAll()
      const lastId = allArticles[allArticles.length - 1]!.id

      const page = await articles.paginateCursor({
        after: lastId,
        pageSize: 10,
      })

      expect(page.nextCursor).toBeUndefined()
      expect(page.data.length).toBe(0)
    })
  })

  describe('Large Dataset Pagination', () => {
    const LargeDataset = orm.entity('test_cursor_large', {
      name: orm.string(),
      value: orm.number(),
    }).build()

    let largeRepo: ReturnType<typeof orm.repo<typeof LargeDataset.schema>>

    beforeAll(async () => {
      largeRepo = orm.repo(LargeDataset)

      // Manually create table for nested describe entity
      await createTestTable(LargeDataset)

      // Create 1000 records
      const data = Array.from({ length: 1000 }, (_, i) => ({
        name: `Record ${i}`,
        value: i,
      }))

      await largeRepo.createMany(data)
    })

    afterAll(async () => {
      await cleanupTables('test_cursor_large')
    })

    test('should efficiently paginate through 1000+ records', async () => {
      const startTime = Date.now()
      let totalFetched = 0
      let cursor: number | undefined
      let pageCount = 0

      while (true) {
        const page = await largeRepo.paginateCursor({
          after: cursor,
          pageSize: 50,
        })

        totalFetched += page.data.length
        pageCount++

        if (!page.hasMore) {
          break
        }

        cursor = page.nextCursor
      }

      const duration = Date.now() - startTime

      expect(totalFetched).toBe(1000)
      expect(pageCount).toBe(20) // 1000 / 50
      expect(duration).toBeLessThan(5000) // Should be fast

      console.log(`Cursor pagination through 1000 records took ${duration}ms (${pageCount} pages)`)
    })

    test('should maintain consistent performance across pages', async () => {
      // First page
      const start1 = Date.now()
      const page1 = await largeRepo.paginateCursor({ pageSize: 50 })
      const duration1 = Date.now() - start1

      // Middle page
      const start2 = Date.now()

      await largeRepo.paginateCursor({
        after: page1.data[page1.data.length - 1]!.id,
        pageSize: 50,
      })
      const duration2 = Date.now() - start2

      console.log(`First page: ${duration1}ms, Middle page: ${duration2}ms`)

      // Performance should be similar (cursor-based doesn't degrade like offset)
      // Allow some variance, but should be in same ballpark
      expect(duration2).toBeLessThan((duration1 + 1) * 3)
    })
  })

  describe('Comparison with Offset Pagination', () => {
    test('should compare cursor vs offset pagination performance', async () => {
      // Cursor pagination
      const cursorStart = Date.now()
      let cursorTotal = 0
      let cursor: number | undefined

      for (let i = 0; i < 10; i++) {
        const page = await articles.paginateCursor({
          after: cursor,
          pageSize: 10,
        })

        cursorTotal += page.data.length
        cursor = page.nextCursor

        if (!page.hasMore)
          break
      }

      const cursorDuration = Date.now() - cursorStart

      // Offset pagination
      const offsetStart = Date.now()
      let offsetTotal = 0

      for (let i = 1; i <= 10; i++) {
        const page = await articles.paginate({
          page: i,
          pageSize: 10,
        })

        offsetTotal += page.data.length
      }

      const offsetDuration = Date.now() - offsetStart

      console.log(`Cursor pagination (10 pages): ${cursorDuration}ms`)
      console.log(`Offset pagination (10 pages): ${offsetDuration}ms`)

      // Both should fetch same amount of data
      expect(cursorTotal).toBe(offsetTotal)

      // Performance should be comparable for early pages
      // (offset degrades on later pages, cursor stays consistent)
    })
  })

  describe('Edge Cases', () => {
    test('should handle empty results', async () => {
      const page = await articles.paginateCursor({
        pageSize: 10,
        where: { category: 'nonexistent' },
      })

      expect(page.data).toEqual([])
      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toBeUndefined()
    })

    test('should handle pageSize larger than total records', async () => {
      const page = await articles.paginateCursor({
        pageSize: 1000,
        where: { category: 'tech' },
      })

      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toBeUndefined()
    })

    test('should handle pageSize of 1', async () => {
      const page1 = await articles.paginateCursor({
        pageSize: 1,
      })

      expect(page1.data.length).toBe(1)
      expect(page1.hasMore).toBe(true)

      const page2 = await articles.paginateCursor({
        after: page1.nextCursor,
        pageSize: 1,
      })

      expect(page2.data.length).toBe(1)
      expect(page2.data[0]!.id).not.toBe(page1.data[0]!.id)
    })
  })
})
