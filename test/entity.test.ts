import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getRepository } from '../src'
import { Tag } from './entities/Tag'
import { User } from './entities/User'
import { cleanTables, createTables, setupTestDB, teardownTestDB } from './setup'

describe('AbstractEntity', () => {
  beforeAll(async () => {
    await setupTestDB()
    await createTables()
  })

  afterAll(async () => {
    await teardownTestDB()
  })

  beforeEach(async () => {
    await cleanTables()
  })

  describe('save()', () => {
    test('should insert new entity', async () => {
      const tag = new Tag({ name: 'test-tag' })

      expect(tag.id).toBeUndefined()

      await tag.save()

      expect(tag.id).toBeNumber()
      expect(tag.id).toBeGreaterThan(0)
    })

    test('should update existing entity', async () => {
      const tag = new Tag({ name: 'original' })

      await tag.save()

      const originalId = tag.id

      tag.name = 'updated'

      await tag.save()

      expect(tag.id).toBe(originalId)
      expect(tag.name).toBe('updated')

      // Verify in database
      const found = await getRepository(Tag).find(tag.id)

      expect(found?.name).toBe('updated')
    })

    test('should work with foreign keys', async () => {
      const tag = new Tag({ name: 'admin' })

      await tag.save()

      const user = new User({ username: 'john', tag_id: tag.id })

      await user.save()

      expect(user.id).toBeNumber()
      expect(user.tag_id).toBe(tag.id)

      // Update user
      user.username = 'jane'
      await user.save()

      expect(user.username).toBe('jane')
    })
  })

  describe('relationships', () => {
    test('should fetch related entity', async () => {
      const tag = new Tag({ name: 'admin' })

      await tag.save()

      const user = new User({ username: 'john', tag_id: tag.id })

      await user.save()

      const fetchedTag = await user.getTagAsync()

      expect(fetchedTag).not.toBeNull()
      expect(fetchedTag?.id).toBe(tag.id)
      expect(fetchedTag?.name).toBe('admin')
    })

    test('should return null for missing relationship', async () => {
      const user = new User({ username: 'john', tag_id: null })

      await user.save()

      const tag = await user.getTagAsync()

      expect(tag).toBeNull()
    })
  })
})
