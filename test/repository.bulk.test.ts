import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getRepository } from '../src'
import { Tag } from './entities/Tag'
import { User } from './entities/User'
import { cleanTables, createTables, setupTestDB, teardownTestDB } from './setup'

describe('Bulk Operations', () => {
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

  describe('createMany', () => {
    test('should create multiple entities in bulk', async () => {
      const tagRepo = getRepository(Tag)

      const tags = await tagRepo.createMany([
        { name: 'tag1', description: 'desc1' },
        { name: 'tag2', description: 'desc2' },
        { name: 'tag3', description: 'desc3' },
      ])

      expect(tags).toBeArrayOfSize(3)
      expect(tags[0]!.id).toBeGreaterThan(0)
      expect(tags[1]!.id).toBeGreaterThan(0)
      expect(tags[2]!.id).toBeGreaterThan(0)

      const count = await tagRepo.count()

      expect(count).toBe(3)
    })

    test('should return empty array for empty input', async () => {
      const tagRepo = getRepository(Tag)

      const tags = await tagRepo.createMany([])

      expect(tags).toBeArrayOfSize(0)
    })

    test('should handle large batch inserts', async () => {
      const tagRepo = getRepository(Tag)

      const batch = Array.from({ length: 100 }, (_, i) => ({
        name: `tag${i}`,
      }))

      const tags = await tagRepo.createMany(batch)

      expect(tags).toBeArrayOfSize(100)

      const count = await tagRepo.count()

      expect(count).toBe(100)
    })
  })

  describe('updateMany', () => {
    test('should update multiple entities', async () => {
      const tagRepo = getRepository(Tag)

      const tag1 = await tagRepo.create({ name: 'tag1', description: 'desc1' })
      const tag2 = await tagRepo.create({ name: 'tag2', description: 'desc2' })

      const updated = await tagRepo.updateMany([
        { id: tag1.id, description: 'updated1' },
        { id: tag2.id, description: 'updated2' },
      ])

      expect(updated).toBeArrayOfSize(2)
      expect(updated[0]!.description).toBe('updated1')
      expect(updated[1]!.description).toBe('updated2')
    })

    test('should return empty array for empty input', async () => {
      const tagRepo = getRepository(Tag)

      const updated = await tagRepo.updateMany([])

      expect(updated).toBeArrayOfSize(0)
    })

    test('should skip updates with no data', async () => {
      const tagRepo = getRepository(Tag)

      const tag = await tagRepo.create({ name: 'tag1' })

      const updated = await tagRepo.updateMany([
        { id: tag.id },
      ])

      expect(updated).toBeArrayOfSize(0)
    })

    test('should be atomic in transaction', async () => {
      const tagRepo = getRepository(Tag)

      const tag1 = await tagRepo.create({ name: 'tag1' })
      const tag2 = await tagRepo.create({ name: 'tag2' })

      await tagRepo.transaction(async () => {
        await tagRepo.updateMany([
          { id: tag1.id, description: 'tx-update1' },
          { id: tag2.id, description: 'tx-update2' },
        ])
      })

      const refreshed1 = await tagRepo.find(tag1.id)
      const refreshed2 = await tagRepo.find(tag2.id)

      expect(refreshed1!.description).toBe('tx-update1')
      expect(refreshed2!.description).toBe('tx-update2')
    })
  })

  describe('deleteMany', () => {
    test('should delete multiple entities', async () => {
      const tagRepo = getRepository(Tag)

      const tag1 = await tagRepo.create({ name: 'tag1' })
      const tag2 = await tagRepo.create({ name: 'tag2' })
      const tag3 = await tagRepo.create({ name: 'tag3' })

      await tagRepo.deleteMany([tag1.id, tag2.id])

      const remaining = await tagRepo.findAll()

      expect(remaining).toBeArrayOfSize(1)
      expect(remaining[0]!.id).toBe(tag3.id)
    })

    test('should do nothing for empty input', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })

      await tagRepo.deleteMany([])

      const count = await tagRepo.count()

      expect(count).toBe(1)
    })

    test('should handle non-existent IDs gracefully', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.deleteMany([99999, 88888])

      const count = await tagRepo.count()

      expect(count).toBe(0)
    })
  })

  describe('Transactions', () => {
    test('should execute operations within transaction', async () => {
      const tagRepo = getRepository(Tag)

      const result = await tagRepo.transaction(async () => {
        await tagRepo.create({ name: 'tx-tag1' })
        await tagRepo.create({ name: 'tx-tag2' })

        return 'completed'
      })

      expect(result).toBe('completed')

      const count = await tagRepo.count()

      expect(count).toBe(2)
    })

    test('should rollback on error', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'before-tx' })

      try {
        await tagRepo.transaction(async () => {
          await tagRepo.create({ name: 'in-tx' })
          throw new Error('Rollback')
        })
      }
      catch {
        // Expected
      }

      const all = await tagRepo.findAll()

      expect(all).toBeArrayOfSize(1)
      expect(all[0]!.name).toBe('before-tx')
    })

    test('should create entities in correct order within transaction', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)

      let tagId: number

      await tagRepo.transaction(async () => {
        const tag = await tagRepo.create({ name: 'tx-tag' })

        tagId = tag.id
      })

      await userRepo.create({ username: 'tx-user', tag_id: tagId! })

      const tags = await tagRepo.count()
      const users = await userRepo.count()

      expect(tags).toBe(1)
      expect(users).toBe(1)
    })

    test('should support nested operations in transaction', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.transaction(async () => {
        const tag1 = await tagRepo.create({ name: 'tag1' })
        const tag2 = await tagRepo.create({ name: 'tag2' })

        await tagRepo.update(tag1.id, { description: 'updated' })
        await tagRepo.delete(tag2.id)

        const tag3 = await tagRepo.create({ name: 'tag3' })

        expect(tag3.id).toBeGreaterThan(0)
      })

      const all = await tagRepo.findAll()

      expect(all).toBeArrayOfSize(2)
      expect(all.find(t => t.name === 'tag1')!.description).toBe('updated')
      expect(all.find(t => t.name === 'tag3')).toBeDefined()
    })
  })
})
