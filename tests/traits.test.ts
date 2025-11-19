import { describe, expect, test } from 'bun:test'
import { orm, publishable, softDelete, timestamps } from '../src'
import { cleanupTables, createTestTable, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Trait System', () => {
  describe('Timestamps Trait', () => {
    test('should add createdAt and updatedAt fields', () => {
      const entity = orm.entity('test', {
        name: orm.string(),
      })
        .use(timestamps())
        .build()

      expect(entity.schema.createdAt).toBeDefined()
      expect(entity.schema.updatedAt).toBeDefined()
      expect(entity.schema.createdAt.type).toBe('timestamp')
      expect(entity.schema.updatedAt.type).toBe('timestamp')
    })

    test('should set timestamps on entity creation', async () => {
      await setupTestDatabase()

      const User = orm.entity('test_timestamps', {
        name: orm.string(),
        email: orm.string(),
      })
        .use(timestamps())
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const before = new Date()
      const user = await users.create({ name: 'Test', email: 'test@example.com' })
      const after = new Date()

      expect(user.createdAt).toBeInstanceOf(Date)
      expect(user.updatedAt).toBeInstanceOf(Date)
      expect(user.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(user.createdAt.getTime()).toBeLessThanOrEqual(after.getTime())

      await cleanupTables('test_timestamps')
      await teardownTestDatabase()
    })
  })

  describe('Soft Delete Trait', () => {
    test('should add deletedAt field and methods', () => {
      const entity = orm.entity('test', {
        name: orm.string(),
      })
        .use(softDelete())
        .build()

      expect(entity.schema.deletedAt).toBeDefined()
      expect(entity.schema.deletedAt.type).toBe('timestamp')
      expect(entity.schema.deletedAt.nullable).toBe(true)
      expect(entity.traits[0]?.name).toBe('softDelete')
    })

    test('should provide soft delete methods', async () => {
      await setupTestDatabase()

      const Post = orm.entity('test_soft_delete', {
        title: orm.string(),
        content: orm.string(),
      })
        .use(softDelete())
        .build()

      await createTestTable(Post)

      const posts = orm.repo(Post)
      const post = await posts.create({ title: 'Test', content: 'Content' })

      expect(post.deletedAt).toBeNull()
      expect(post.isDeleted()).toBe(false)

      const deleted = await post.softDelete()

      expect(deleted.deletedAt).toBeInstanceOf(Date)
      expect(deleted.isDeleted()).toBe(true)

      const restored = await deleted.restore()

      expect(restored.deletedAt).toBeNull()
      expect(restored.isDeleted()).toBe(false)

      await cleanupTables('test_soft_delete')
      await teardownTestDatabase()
    })
  })

  describe('Publishable Trait', () => {
    test('should add published fields and methods', () => {
      const entity = orm.entity('test', {
        title: orm.string(),
      })
        .use(publishable())
        .build()

      expect(entity.schema.published).toBeDefined()
      expect(entity.schema.publishedAt).toBeDefined()
      expect(entity.schema.published.type).toBe('boolean')
      expect(entity.schema.publishedAt.type).toBe('timestamp')
      expect(entity.traits[0]?.name).toBe('publishable')
    })

    test('should provide publish/unpublish methods', async () => {
      await setupTestDatabase()

      const Article = orm.entity('test_publishable', {
        title: orm.string(),
        content: orm.string(),
      })
        .use(publishable())
        .build()

      await createTestTable(Article)

      const articles = orm.repo(Article)
      const article = await articles.create({ title: 'Test', content: 'Content' })

      expect(article.published).toBe(false)
      expect(article.publishedAt).toBeNull()
      expect(article.isDraft()).toBe(true)
      expect(article.isPublished()).toBe(false)

      const published = await article.publish()

      expect(published.published).toBe(true)
      expect(published.publishedAt).toBeInstanceOf(Date)
      expect(published.isDraft()).toBe(false)
      expect(published.isPublished()).toBe(true)

      const unpublished = await published.unpublish()

      expect(unpublished.published).toBe(false)
      expect(unpublished.isDraft()).toBe(true)

      await cleanupTables('test_publishable')
      await teardownTestDatabase()
    })
  })

  describe('Custom Traits', () => {
    test('should create custom trait with fields', () => {
      const customTrait = orm.trait('custom')
        .field('customField', orm.string())
        .field('customNumber', orm.number().default(0))
        .build()

      expect(customTrait.name).toBe('custom')
      expect(customTrait.fields.customField).toBeDefined()
      expect(customTrait.fields.customNumber).toBeDefined()
    })

    test('should create custom trait with methods', () => {
      const customTrait = orm.trait('likeable')
        .field('likesCount', orm.number().default(0))
        .method('like', async function (repo) {
          return repo.update(this.id, { likesCount: this.likesCount + 1 })
        })
        .method('unlike', async function (repo) {
          return repo.update(this.id, { likesCount: this.likesCount - 1 })
        })
        .build()

      expect(customTrait.methods.like).toBeDefined()
      expect(customTrait.methods.unlike).toBeDefined()
    })

    test('should use custom trait in entity', async () => {
      await setupTestDatabase()

      const likeable = orm.trait('likeable')
        .field('likesCount', orm.number().integer().default(0))
        .method('like', async function (repo) {
          return repo.update(this.id, { likesCount: this.likesCount + 1 })
        })
        .build()

      const Post = orm.entity('test_custom_trait', {
        title: orm.string(),
        content: orm.string(),
      })
        .use(likeable)
        .build()

      await createTestTable(Post)

      const posts = orm.repo(Post)
      let post = await posts.create({ title: 'Test', content: 'Content' })

      expect(post.likesCount).toBe(0)

      post = await post.like()
      expect(post.likesCount).toBe(1)

      post = await post.like()
      expect(post.likesCount).toBe(2)

      await cleanupTables('test_custom_trait')
      await teardownTestDatabase()
    })
  })

  describe('Multiple Traits', () => {
    test('should combine multiple traits', async () => {
      await setupTestDatabase()

      const Post = orm.entity('test_multi_trait', {
        title: orm.string(),
        content: orm.string(),
      })
        .use(timestamps())
        .use(publishable())
        .use(softDelete())
        .build()

      await createTestTable(Post)

      const posts = orm.repo(Post)
      const post = await posts.create({ title: 'Test', content: 'Content' })

      // Timestamps
      expect(post.createdAt).toBeInstanceOf(Date)
      expect(post.updatedAt).toBeInstanceOf(Date)

      // Publishable
      expect(post.published).toBe(false)
      expect(post.publishedAt).toBeNull()

      // Soft delete
      expect(post.deletedAt).toBeNull()

      // Test all methods work
      const published = await post.publish()

      expect(published.isPublished()).toBe(true)

      const deleted = await published.softDelete()

      expect(deleted.isDeleted()).toBe(true)

      await cleanupTables('test_multi_trait')
      await teardownTestDatabase()
    })
  })

  describe('Trait Method Context', () => {
    test('should bind this to entity instance', async () => {
      await setupTestDatabase()

      const counterTrait = orm.trait('counter')
        .field('count', orm.number().default(0))
        .method('increment', async function (repo) {
          // 'this' should be the entity instance
          expect(this.id).toBeGreaterThan(0)
          expect(this.count).toBeDefined()

          return repo.update(this.id, { count: this.count + 1 })
        })
        .build()

      const Item = orm.entity('test_trait_context', {
        name: orm.string(),
      })
        .use(counterTrait)
        .build()

      await createTestTable(Item)

      const items = orm.repo(Item)
      let item = await items.create({ name: 'Test' })

      item = await item.increment()
      expect(item.count).toBe(1)

      await cleanupTables('test_trait_context')
      await teardownTestDatabase()
    })

    test('should provide repository access in methods', async () => {
      await setupTestDatabase()

      const testTrait = orm.trait('test')
        .field('value', orm.number().default(0))
        .method('doubleValue', async function (repo) {
          // repo should have all repository methods
          const current = await repo.find(this.id)

          expect(current).not.toBeNull()

          return repo.update(this.id, { value: this.value * 2 })
        })
        .build()

      const Item = orm.entity('test_repo_access', {
        name: orm.string(),
      })
        .use(testTrait)
        .build()

      await createTestTable(Item)

      const items = orm.repo(Item)
      let item = await items.create({ name: 'Test', value: 5 })

      item = await item.doubleValue()
      expect(item.value).toBe(10)

      await cleanupTables('test_repo_access')
      await teardownTestDatabase()
    })
  })
})
