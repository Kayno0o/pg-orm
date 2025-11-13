import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { EntityNotFoundError, getRepository } from '../src'
import { Tag } from './entities/Tag'
import { User } from './entities/User'
import { cleanTables, createTables, setupTestDB, teardownTestDB } from './setup'

describe('Repository Helper Methods', () => {
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

  describe('count', () => {
    test('should count all entities', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })
      await tagRepo.create({ name: 'tag3' })

      const count = await tagRepo.count()

      expect(count).toBe(3)
    })

    test('should count with filters', async () => {
      const userRepo = getRepository(User)

      await userRepo.create({ username: 'active1', active: true })
      await userRepo.create({ username: 'active2', active: true })
      await userRepo.create({ username: 'inactive', active: false })

      const activeCount = await userRepo.count({
        where: { active: true },
      })

      expect(activeCount).toBe(2)
    })

    test('should return 0 for empty table', async () => {
      const tagRepo = getRepository(Tag)

      const count = await tagRepo.count()

      expect(count).toBe(0)
    })
  })

  describe('exists', () => {
    test('should return true if entity exists', async () => {
      const tagRepo = getRepository(Tag)

      const tag = await tagRepo.create({ name: 'exists' })

      const exists = await tagRepo.exists(tag.id)

      expect(exists).toBe(true)
    })

    test('should return false if entity does not exist', async () => {
      const tagRepo = getRepository(Tag)

      const exists = await tagRepo.exists(99999)

      expect(exists).toBe(false)
    })
  })

  describe('existsBy', () => {
    test('should return true if entity matches conditions', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'test' })

      const exists = await tagRepo.existsBy({
        where: { name: 'test' },
      })

      expect(exists).toBe(true)
    })

    test('should return false if no entity matches', async () => {
      const tagRepo = getRepository(Tag)

      const exists = await tagRepo.existsBy({
        where: { name: 'nonexistent' },
      })

      expect(exists).toBe(false)
    })
  })

  describe('findOrFail', () => {
    test('should return entity if found', async () => {
      const tagRepo = getRepository(Tag)

      const created = await tagRepo.create({ name: 'test' })

      const found = await tagRepo.findOrFail(created.id)

      expect(found).toBeDefined()
      expect(found.name).toBe('test')
    })

    test('should throw EntityNotFoundError if not found', async () => {
      const tagRepo = getRepository(Tag)

      expect(async () => {
        await tagRepo.findOrFail(99999)
      }).toThrow(EntityNotFoundError)
    })
  })

  describe('findByOrFail', () => {
    test('should return entity if found', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'test' })

      const found = await tagRepo.findByOrFail({
        where: { name: 'test' },
      })

      expect(found).toBeDefined()
      expect(found.name).toBe('test')
    })

    test('should throw EntityNotFoundError if not found', async () => {
      const tagRepo = getRepository(Tag)

      expect(async () => {
        await tagRepo.findByOrFail({
          where: { name: 'nonexistent' },
        })
      }).toThrow(EntityNotFoundError)
    })
  })

  describe('paginate', () => {
    beforeEach(async () => {
      const tagRepo = getRepository(Tag)

      for (let i = 1; i <= 25; i++) {
        await tagRepo.create({ name: `tag${i}` })
      }
    })

    test('should paginate results', async () => {
      const tagRepo = getRepository(Tag)

      const result = await tagRepo.paginate({
        page: 1,
        pageSize: 10,
      })

      expect(result.data).toBeArrayOfSize(10)
      expect(result.meta.total).toBe(25)
      expect(result.meta.page).toBe(1)
      expect(result.meta.pageSize).toBe(10)
      expect(result.meta.totalPages).toBe(3)
      expect(result.meta.hasNext).toBe(true)
      expect(result.meta.hasPrevious).toBe(false)
    })

    test('should paginate to last page', async () => {
      const tagRepo = getRepository(Tag)

      const result = await tagRepo.paginate({
        page: 3,
        pageSize: 10,
      })

      expect(result.data).toBeArrayOfSize(5)
      expect(result.meta.hasNext).toBe(false)
      expect(result.meta.hasPrevious).toBe(true)
    })

    test('should paginate with filters', async () => {
      const userRepo = getRepository(User)

      for (let i = 1; i <= 15; i++) {
        await userRepo.create({ username: `user${i}`, active: i % 2 === 0 })
      }

      const result = await userRepo.paginate({
        page: 1,
        pageSize: 5,
        where: { active: true },
      })

      expect(result.data).toBeArrayOfSize(5)
      expect(result.meta.total).toBe(7)
      expect(result.data.every(u => u.active)).toBe(true)
    })

    test('should paginate with ordering', async () => {
      const tagRepo = getRepository(Tag)

      const result = await tagRepo.paginate({
        page: 1,
        pageSize: 5,
        order: { name: 'ASC' },
      })

      expect(result.data[0]!.name).toBe('tag1')
      expect(result.data[1]!.name).toBe('tag10')
    })
  })

  describe('upsert', () => {
    test('should insert new entity when no conflict', async () => {
      const tagRepo = getRepository(Tag)

      const result = await tagRepo.upsert({ name: 'new-tag' })

      expect(result).toBeDefined()
      expect(result.name).toBe('new-tag')
      expect(result.id).toBeGreaterThan(0)

      const count = await tagRepo.count()

      expect(count).toBe(1)
    })

    test('should update existing entity on conflict', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'test', description: 'original' })

      const result = await tagRepo.upsert({ name: 'test', description: 'updated' })

      expect(result.description).toBe('updated')

      const count = await tagRepo.count()

      expect(count).toBe(1)
    })

    test('should work without unique constraints', async () => {
      const userRepo = getRepository(User)

      const result = await userRepo.upsert({ username: 'test' })

      expect(result).toBeDefined()
      expect(result.username).toBe('test')
    })
  })
})
