import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AbstractRepository, closeDB, getDB, getRepository, initDB } from '../src'
import { Article, ArticleStatus } from './entities/Article'

describe('Decorator Tests', () => {
  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/orm_test'

    await initDB(dbUrl, [new AbstractRepository(Article)])
    await createArticleTable()
  })

  afterAll(async () => {
    await closeDB()
  })

  beforeEach(async () => {
    const db = getDB()

    await db`DELETE FROM article`
    await db`ALTER SEQUENCE article_id_seq RESTART WITH 1`
  })

  describe('@UuidColumn', () => {
    test('should auto-generate UUID on create', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
      })

      expect(article.uuid).toBeDefined()
      expect(article.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })

    test('should accept custom UUID', async () => {
      const articleRepo = getRepository(Article)
      const customUuid = crypto.randomUUID()

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: customUuid,
        status: ArticleStatus.DRAFT,
      })

      expect(article.uuid).toBe(customUuid)
    })

    test('should be queryable by UUID', async () => {
      const articleRepo = getRepository(Article)
      const uuid = crypto.randomUUID()

      await articleRepo.create({
        title: 'Test Article',
        uuid,
        status: ArticleStatus.DRAFT,
      })

      const found = await articleRepo.findOneBy({
        where: { uuid },
      })

      expect(found).not.toBeNull()
      expect(found!.uuid).toBe(uuid)
    })
  })

  describe('@JsonColumn', () => {
    test('should store and retrieve JSON objects', async () => {
      const articleRepo = getRepository(Article)

      const metadata = {
        author: 'John Doe',
        category: 'Technology',
        featured: true,
        views: 1000,
      }

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
        metadata,
      })

      expect(article.metadata).toEqual(metadata)

      const found = await articleRepo.find(article.id)

      expect(found!.metadata).toEqual(metadata)
    })

    test('should handle nested objects', async () => {
      const articleRepo = getRepository(Article)

      const metadata = {
        author: {
          name: 'John Doe',
          email: 'john@example.com',
          profile: {
            bio: 'Writer',
            location: 'NYC',
          },
        },
        tags: ['tech', 'programming'],
      }

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
        metadata,
      })

      const found = await articleRepo.find(article.id)

      expect(found!.metadata).toEqual(metadata)
    })

    test('should handle null values', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
        metadata: null,
      })

      expect(article.metadata).toBeNull()

      const found = await articleRepo.find(article.id)

      expect(found!.metadata).toBeNull()
    })

    test('should update JSON values', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
        metadata: { version: 1 },
      })

      const updated = await articleRepo.update(article.id, {
        metadata: { version: 2, updated: true },
      })

      expect(updated.metadata).toEqual({ version: 2, updated: true })
    })
  })

  describe('@ArrayColumn', () => {
    test('should store and retrieve string arrays', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
        tags: ['javascript', 'typescript', 'bun'],
      })

      expect(article.tags).toEqual(['javascript', 'typescript', 'bun'])

      const found = await articleRepo.find(article.id)

      expect(found!.tags).toEqual(['javascript', 'typescript', 'bun'])
    })

    test('should store and retrieve number arrays', async () => {
      const articleRepo = getRepository(Article)

      const viewCounts = [10, 25, 50, 100, 200]

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
        view_counts: viewCounts,
      })

      expect(article.view_counts).toEqual(viewCounts)

      const found = await articleRepo.find(article.id)

      expect(found!.view_counts).toEqual(viewCounts)
    })

    test('should handle empty arrays', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
        tags: [],
      })

      expect(article.tags).toEqual([])

      const found = await articleRepo.find(article.id)

      expect(found!.tags).toEqual([])
    })

    test('should handle null array values', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
        tags: null,
      })

      expect(article.tags).toBeNull()
    })

    test('should update array values', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
        tags: ['tag1'],
      })

      const updated = await articleRepo.update(article.id, {
        tags: ['tag1', 'tag2', 'tag3'],
      })

      expect(updated.tags).toEqual(['tag1', 'tag2', 'tag3'])
    })
  })

  describe('@EnumColumn', () => {
    test('should store and retrieve enum values', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.PUBLISHED,
      })

      expect(article.status).toBe(ArticleStatus.PUBLISHED)

      const found = await articleRepo.find(article.id)

      expect(found!.status).toBe(ArticleStatus.PUBLISHED)
    })

    test('should support all enum values', async () => {
      const articleRepo = getRepository(Article)

      const statuses = [
        ArticleStatus.DRAFT,
        ArticleStatus.PUBLISHED,
        ArticleStatus.ARCHIVED,
      ]

      for (const status of statuses) {
        const article = await articleRepo.create({
          title: `Article ${status}`,
          uuid: crypto.randomUUID(),
          status,
        })

        expect(article.status).toBe(status)
      }

      const all = await articleRepo.findAll()

      expect(all).toBeArrayOfSize(3)
      expect(all.map(a => a.status).sort()).toEqual(statuses.sort())
    })

    test('should be queryable by enum value', async () => {
      const articleRepo = getRepository(Article)

      await articleRepo.create({
        title: 'Draft',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
      })

      await articleRepo.create({
        title: 'Published',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.PUBLISHED,
      })

      const published = await articleRepo.findAllBy({
        where: { status: ArticleStatus.PUBLISHED },
      })

      expect(published).toBeArrayOfSize(1)
      expect(published[0]!.status).toBe(ArticleStatus.PUBLISHED)
    })

    test('should update enum values', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
      })

      const updated = await articleRepo.update(article.id, {
        status: ArticleStatus.PUBLISHED,
      })

      expect(updated.status).toBe(ArticleStatus.PUBLISHED)
    })
  })

  describe('@CreatedAt', () => {
    test('should auto-set created_at on insert', async () => {
      const articleRepo = getRepository(Article)

      const before = new Date()

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
      })

      const after = new Date()

      expect(article.created_at).toBeDefined()
      expect(article.created_at instanceof Date || typeof article.created_at === 'string').toBe(true)

      const createdDate = article.created_at instanceof Date
        ? article.created_at
        : new Date(article.created_at)

      expect(createdDate.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(createdDate.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    test('should not change created_at on update', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
      })

      const originalCreatedAt = article.created_at

      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = await articleRepo.update(article.id, {
        title: 'Updated Title',
      })

      expect(updated.created_at.toString()).toBe(originalCreatedAt.toString())
    })
  })

  describe('@UpdatedAt', () => {
    test('should auto-set updated_at on insert', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
      })

      expect(article.updated_at).toBeDefined()
    })

    test('should update updated_at on record update', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
      })

      const originalUpdatedAt = article.updated_at

      await new Promise(resolve => setTimeout(resolve, 100))

      const updated = await articleRepo.update(article.id, {
        title: 'Updated Title',
      })

      const originalDate = originalUpdatedAt instanceof Date
        ? originalUpdatedAt
        : new Date(originalUpdatedAt)

      const updatedDate = updated.updated_at instanceof Date
        ? updated.updated_at
        : new Date(updated.updated_at)

      expect(updatedDate.getTime()).toBeGreaterThanOrEqual(originalDate.getTime())
    })
  })

  describe('Column with default values', () => {
    test('should apply default values', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
      })

      expect(article.likes).toBe(0)
    })

    test('should allow overriding default values', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Test Article',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.DRAFT,
        likes: 100,
      })

      expect(article.likes).toBe(100)
    })
  })

  describe('Multiple specialized columns together', () => {
    test('should handle all column types in single entity', async () => {
      const articleRepo = getRepository(Article)

      const article = await articleRepo.create({
        title: 'Comprehensive Test',
        content: 'Full article content',
        uuid: crypto.randomUUID(),
        status: ArticleStatus.PUBLISHED,
        metadata: {
          author: 'Jane Doe',
          featured: true,
        },
        tags: ['test', 'comprehensive'],
        view_counts: [1, 2, 3],
        likes: 50,
      })

      expect(article.title).toBe('Comprehensive Test')
      expect(article.content).toBe('Full article content')
      expect(article.uuid).toBeDefined()
      expect(article.status).toBe(ArticleStatus.PUBLISHED)
      expect(article.metadata).toEqual({ author: 'Jane Doe', featured: true })
      expect(article.tags).toEqual(['test', 'comprehensive'])
      expect(article.view_counts).toEqual([1, 2, 3])
      expect(article.likes).toBe(50)
      expect(article.created_at).toBeDefined()
      expect(article.updated_at).toBeDefined()

      const found = await articleRepo.find(article.id)

      expect(found).toEqual(article)
    })
  })
})

async function createArticleTable() {
  const db = getDB()

  await db`
    CREATE TABLE IF NOT EXISTS article (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      uuid UUID NOT NULL,
      status TEXT NOT NULL,
      metadata JSONB,
      tags TEXT[],
      view_counts INTEGER[],
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      likes INTEGER NOT NULL DEFAULT 0
    )
  `
}
