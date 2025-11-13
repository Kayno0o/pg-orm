import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { EntityNotFoundError, getRepository } from '../src'
import { Tag } from './entities/Tag'
import { User } from './entities/User'
import { cleanTables, createTables, setupTestDB, teardownTestDB } from './setup'

describe('Entity Advanced Operations', () => {
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

  describe('save method edge cases', () => {
    test('should handle rapid consecutive saves', async () => {
      const tag = new Tag()

      tag.name = 'test'

      await tag.save()
      const firstId = tag.id

      tag.name = 'updated1'
      await tag.save()

      tag.name = 'updated2'
      await tag.save()

      expect(tag.id).toBe(firstId)
      expect(tag.name).toBe('updated2')

      const tagRepo = getRepository(Tag)
      const fresh = await tagRepo.find(firstId)

      expect(fresh!.name).toBe('updated2')
    })

    test('should preserve unchanged fields on update', async () => {
      const tag = new Tag()

      tag.name = 'test'
      tag.description = 'original'

      await tag.save()

      tag.name = 'updated'
      await tag.save()

      const tagRepo = getRepository(Tag)
      const fresh = await tagRepo.find(tag.id)

      expect(fresh!.description).toBe('original')
    })

    test('should handle null values correctly', async () => {
      const tag = new Tag()

      tag.name = 'test'
      tag.description = 'has description'

      await tag.save()

      tag.description = null
      await tag.save()

      const tagRepo = getRepository(Tag)
      const fresh = await tagRepo.find(tag.id)

      expect(fresh!.description).toBeNull()
    })
  })

  describe('reload method', () => {
    test('should reload fresh data from database', async () => {
      const tag = new Tag()

      tag.name = 'original'

      await tag.save()

      const tagRepo = getRepository(Tag)

      await tagRepo.update(tag.id, { name: 'external-update' })

      await tag.reload()

      expect(tag.name).toBe('external-update')
    })

    test('should throw error for entity without ID', async () => {
      const tag = new Tag()

      tag.name = 'test'

      expect(async () => {
        await tag.reload()
      }).toThrow('Cannot reload entity without id')
    })

    test('should throw EntityNotFoundError if entity was deleted', async () => {
      const tag = new Tag()

      tag.name = 'test'

      await tag.save()

      const tagRepo = getRepository(Tag)

      await tagRepo.delete(tag.id)

      expect(async () => {
        await tag.reload()
      }).toThrow(EntityNotFoundError)
    })
  })

  describe('remove method', () => {
    test('should delete entity from database', async () => {
      const tag = new Tag()

      tag.name = 'to-delete'

      await tag.save()
      const id = tag.id

      await tag.remove()

      const tagRepo = getRepository(Tag)
      const exists = await tagRepo.exists(id)

      expect(exists).toBe(false)
    })

    test('should throw error for entity without ID', async () => {
      const tag = new Tag()

      tag.name = 'test'

      expect(async () => {
        await tag.remove()
      }).toThrow('Cannot remove entity without id')
    })

    test('should not error if entity already deleted', async () => {
      const tag = new Tag()

      tag.name = 'test'

      await tag.save()
      await tag.remove()

      expect(async () => {
        await tag.remove()
      }).not.toThrow()
    })
  })

  describe('toObject and toJSON', () => {
    test('should convert entity to plain object', async () => {
      const tag = new Tag()

      tag.name = 'test'
      tag.description = 'desc'

      await tag.save()

      const obj = tag.toObject()

      expect(obj).toHaveProperty('id')
      expect(obj).toHaveProperty('name', 'test')
      expect(obj).toHaveProperty('description', 'desc')
      expect(typeof obj.save).toBe('undefined')
    })

    test('should exclude methods from toObject', async () => {
      const tag = new Tag()

      tag.name = 'test'

      await tag.save()

      const obj = tag.toObject()

      expect(obj).not.toHaveProperty('save')
      expect(obj).not.toHaveProperty('reload')
      expect(obj).not.toHaveProperty('remove')
      expect(obj).not.toHaveProperty('toObject')
      expect(obj).not.toHaveProperty('toJSON')
    })

    test('should handle null values', async () => {
      const user = new User()

      user.username = 'test'
      user.tag_id = null

      await user.save()

      const obj = user.toObject()

      expect(obj.tag_id).toBeNull()
      expect(obj.active).toBeDefined()
    })

    test('toJSON should return same as toObject', async () => {
      const tag = new Tag()

      tag.name = 'test'

      await tag.save()

      const obj = tag.toObject()
      const json = tag.toJSON()

      expect(json).toEqual(obj)
    })

    test('should work with JSON.stringify', async () => {
      const tag = new Tag()

      tag.name = 'test'
      tag.description = 'desc'

      await tag.save()

      const jsonString = JSON.stringify(tag)
      const parsed = JSON.parse(jsonString)

      expect(parsed.name).toBe('test')
      expect(parsed.description).toBe('desc')
      expect(parsed.save).toBeUndefined()
    })
  })

  describe('Foreign key relationships', () => {
    test('should maintain foreign key integrity', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)

      const tag = await tagRepo.create({ name: 'admin' })

      const user = new User()

      user.username = 'testuser'
      user.tag_id = tag.id

      await user.save()

      expect(user.tag_id).toBe(tag.id)

      const fresh = await userRepo.find(user.id)

      expect(fresh!.tag_id).toBe(tag.id)
    })

    test('should allow null foreign keys', async () => {
      const user = new User()

      user.username = 'testuser'
      user.tag_id = null

      await user.save()

      expect(user.tag_id).toBeNull()
    })

    test('should update foreign key relationships', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)

      const tag1 = await tagRepo.create({ name: 'tag1' })
      const tag2 = await tagRepo.create({ name: 'tag2' })

      const user = new User()

      user.username = 'testuser'
      user.tag_id = tag1.id

      await user.save()

      user.tag_id = tag2.id
      await user.save()

      const fresh = await userRepo.find(user.id)

      expect(fresh!.tag_id).toBe(tag2.id)
    })
  })

  describe('Concurrency scenarios', () => {
    test('should handle concurrent saves', async () => {
      const tag1 = new Tag()

      tag1.name = 'concurrent1'

      const tag2 = new Tag()

      tag2.name = 'concurrent2'

      await Promise.all([
        tag1.save(),
        tag2.save(),
      ])

      expect(tag1.id).toBeGreaterThan(0)
      expect(tag2.id).toBeGreaterThan(0)
      expect(tag1.id).not.toBe(tag2.id)
    })

    test('should handle concurrent updates to different entities', async () => {
      const tagRepo = getRepository(Tag)

      const tag1 = await tagRepo.create({ name: 'tag1' })
      const tag2 = await tagRepo.create({ name: 'tag2' })

      await Promise.all([
        tagRepo.update(tag1.id, { description: 'updated1' }),
        tagRepo.update(tag2.id, { description: 'updated2' }),
      ])

      const fresh1 = await tagRepo.find(tag1.id)
      const fresh2 = await tagRepo.find(tag2.id)

      expect(fresh1!.description).toBe('updated1')
      expect(fresh2!.description).toBe('updated2')
    })
  })
})
