import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm, publishable, softDelete, timestamps } from '../src'
import { cleanupTables, createTestTable, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Trait System', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

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
      // Allow 100ms tolerance for clock skew between app and database
      expect(user.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100)
      expect(user.createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 100)

      await cleanupTables('test_timestamps')
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
    })

    test('should provide soft delete methods', async () => {

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
    })

    test('should provide publish/unpublish methods', async () => {

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
    })
  })

  describe('Custom Traits', () => {
    test('should create custom trait with fields', () => {
      const customTrait = orm.trait()
        .field('customField', orm.string())
        .field('customNumber', orm.number().default(0))
        .build()

      expect(customTrait.fields.customField).toBeDefined()
      expect(customTrait.fields.customNumber).toBeDefined()
    })

    test('should create custom trait with methods', () => {
      const customTrait = orm.trait()
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

      const likeable = orm.trait()
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
    })
  })

  describe('Multiple Traits', () => {
    test('should combine multiple traits', async () => {

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
    })
  })

  describe('Trait Method Context', () => {
    test('should bind this to entity instance', async () => {

      const counterTrait = orm.trait()
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
    })

    test('should provide repository access in methods', async () => {

      const testTrait = orm.trait()
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
    })
  })

  describe('Trait Hooks', () => {
    test('should execute trait hooks on create', async () => {

      const hookCalls: string[] = []

      const customTrait = orm.trait()
        .field('value', orm.number().default(0))
        .beforeCreate((data: any) => {
          hookCalls.push('trait-beforeCreate')
          data.value = (data.value || 0) + 10
        })
        .build()

      const Entity = orm.entity('test_trait_hooks', {
        name: orm.string(),
      })
        .use(customTrait)
        .beforeCreate((data: any) => {
          hookCalls.push('entity-beforeCreate')
          data.value += 5
        })
        .build()

      await createTestTable(Entity)

      const repo = orm.repo(Entity)
      const item = await repo.create({ name: 'Test', value: 1 })

      // Verify hooks were called in correct order: trait first, then entity
      expect(hookCalls).toEqual(['trait-beforeCreate', 'entity-beforeCreate'])
      // Verify both hooks modified the data
      expect(item.value).toBe(16) // 1 + 10 (trait) + 5 (entity)

      await cleanupTables('test_trait_hooks')
    })

    test('should execute trait hooks on update', async () => {

      const hookCalls: string[] = []

      const customTrait = orm.trait()
        .field('value', orm.number().default(0))
        .beforeUpdate((_id: number, data: any) => {
          hookCalls.push('trait-beforeUpdate')

          if (data.value !== undefined) {
            data.value *= 2
          }
        })
        .build()

      const Entity = orm.entity('test_trait_update_hooks', {
        name: orm.string(),
      })
        .use(customTrait)
        .beforeUpdate((_id: number, data: any) => {
          hookCalls.push('entity-beforeUpdate')

          if (data.value !== undefined) {
            data.value += 1
          }
        })
        .build()

      await createTestTable(Entity)

      const repo = orm.repo(Entity)
      const item = await repo.create({ name: 'Test', value: 5 })

      hookCalls.length = 0 // Clear hook calls from creation

      const updated = await repo.update(item.id, { value: 3 })

      // Verify hooks were called in correct order: trait first, then entity
      expect(hookCalls).toEqual(['trait-beforeUpdate', 'entity-beforeUpdate'])
      // Verify both hooks modified the data: 3 * 2 (trait) + 1 (entity) = 7
      expect(updated.value).toBe(7)

      await cleanupTables('test_trait_update_hooks')
    })

    test('should handle multiple traits with hooks', async () => {

      const hookCalls: string[] = []

      const trait1 = orm.trait()
        .field('value1', orm.number().default(0))
        .beforeCreate((data: any) => {
          hookCalls.push('trait1-beforeCreate')
          data.value1 = 10
        })
        .build()

      const trait2 = orm.trait()
        .field('value2', orm.number().default(0))
        .beforeCreate((data: any) => {
          hookCalls.push('trait2-beforeCreate')
          data.value2 = 20
        })
        .build()

      const Entity = orm.entity('test_multi_trait_hooks', {
        name: orm.string(),
      })
        .use(trait1)
        .use(trait2)
        .beforeCreate((data: any) => {
          hookCalls.push('entity-beforeCreate')
          data.name = data.name.toUpperCase()
        })
        .build()

      await createTestTable(Entity)

      const repo = orm.repo(Entity)
      const item = await repo.create({ name: 'test' })

      // Verify hooks were called in application order
      expect(hookCalls).toEqual(['trait1-beforeCreate', 'trait2-beforeCreate', 'entity-beforeCreate'])
      expect(item.value1).toBe(10)
      expect(item.value2).toBe(20)
      expect(item.name).toBe('TEST')

      await cleanupTables('test_multi_trait_hooks')
    })

    test('timestamps trait should use hooks', async () => {
      const Entity = orm.entity('test_timestamps_hooks', {
        name: orm.string(),
      })
        .use(timestamps())
        .build()

      await createTestTable(Entity)

      const repo = orm.repo(Entity)
      const before = new Date()
      const item = await repo.create({ name: 'Test' })
      const after = new Date()

      // Verify createdAt and updatedAt were set by hooks
      expect(item.createdAt).toBeInstanceOf(Date)
      expect(item.updatedAt).toBeInstanceOf(Date)
      expect(item.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100)
      expect(item.createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 100)

      // Wait a bit and update
      await new Promise(resolve => setTimeout(resolve, 50))

      const updateBefore = new Date()
      const updated = await repo.update(item.id, { name: 'Updated' })
      const updateAfter = new Date()

      // Verify updatedAt was changed by hook
      expect(updated.updatedAt.getTime()).toBeGreaterThan(item.updatedAt.getTime())
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(updateBefore.getTime() - 100)
      expect(updated.updatedAt.getTime()).toBeLessThanOrEqual(updateAfter.getTime() + 100)
      // createdAt should remain unchanged
      expect(updated.createdAt.getTime()).toBe(item.createdAt.getTime())

      await cleanupTables('test_timestamps_hooks')
    })

    test('should support all hook types in traits', async () => {
      const hookCalls: string[] = []

      const trackedTrait = orm.trait()
        .field('trackingData', orm.string().nullable())
        .beforeCreate(() => {
          hookCalls.push('beforeCreate')
        })
        .afterCreate(() => {
          hookCalls.push('afterCreate')
        })
        .beforeUpdate(() => {
          hookCalls.push('beforeUpdate')
        })
        .afterUpdate(() => {
          hookCalls.push('afterUpdate')
        })
        .beforeDelete(() => {
          hookCalls.push('beforeDelete')
        })
        .afterDelete(() => {
          hookCalls.push('afterDelete')
        })
        .build()

      const Entity = orm.entity('test_all_hooks', {
        name: orm.string(),
      })
        .use(trackedTrait)
        .build()

      // Ensure fresh table creation (avoid conflicts from concurrent tests)
      await orm.getDB()`DROP TABLE IF EXISTS test_all_hooks CASCADE`
      await createTestTable(Entity)

      const repo = orm.repo(Entity)

      // Create
      const item = await repo.create({ name: 'Test' })

      expect(hookCalls).toContain('beforeCreate')
      expect(hookCalls).toContain('afterCreate')

      hookCalls.length = 0

      // Update
      await repo.update(item.id, { name: 'Updated' })
      expect(hookCalls).toContain('beforeUpdate')
      expect(hookCalls).toContain('afterUpdate')

      hookCalls.length = 0

      // Delete
      await repo.delete(item.id)
      expect(hookCalls).toContain('beforeDelete')
      expect(hookCalls).toContain('afterDelete')

      await cleanupTables('test_all_hooks')
    })
  })
})
