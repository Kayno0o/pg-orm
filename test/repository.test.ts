import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getRepository } from '../src'
import { Tag } from './entities/Tag'
import { User } from './entities/User'
import { cleanTables, createTables, setupTestDB, teardownTestDB } from './setup'

describe('AbstractRepository', () => {
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

  describe('create', () => {
    test('should create a new entity', async () => {
      const tagRepo = getRepository(Tag)
      const tag = await tagRepo.create({ name: 'test-tag' })

      expect(tag.id).toBeNumber()
      expect(tag.id).toBeGreaterThan(0)
      expect(tag.name).toBe('test-tag')
      expect(tag.description).toBeNull()
    })

    test('should create entity with nullable fields', async () => {
      const tagRepo = getRepository(Tag)
      const tag = await tagRepo.create({
        name: 'test-tag',
        description: 'A test tag',
      })

      expect(tag.id).toBeNumber()
      expect(tag.name).toBe('test-tag')
      expect(tag.description).toBe('A test tag')
    })

    test('should create entity with foreign key', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)

      const tag = await tagRepo.create({ name: 'admin' })
      const user = await userRepo.create({
        username: 'john',
        tag_id: tag.id,
      })

      expect(user.id).toBeNumber()
      expect(user.username).toBe('john')
      expect(user.tag_id).toBe(tag.id)
    })
  })

  describe('find', () => {
    test('should find entity by id', async () => {
      const tagRepo = getRepository(Tag)
      const created = await tagRepo.create({ name: 'findable' })

      const found = await tagRepo.find(created.id)

      expect(found).not.toBeNull()
      expect(found?.id).toBe(created.id)
      expect(found?.name).toBe('findable')
    })

    test('should return null for non-existent id', async () => {
      const tagRepo = getRepository(Tag)
      const found = await tagRepo.find(999999)

      expect(found).toBeNull()
    })
  })

  describe('findAll', () => {
    test('should find all entities', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })
      await tagRepo.create({ name: 'tag3' })

      const all = await tagRepo.findAll()

      expect(all).toBeArrayOfSize(3)
      expect(all.map(t => t.name)).toEqual(['tag1', 'tag2', 'tag3'])
    })

    test('should return empty array when no entities exist', async () => {
      const tagRepo = getRepository(Tag)
      const all = await tagRepo.findAll()

      expect(all).toBeArrayOfSize(0)
    })
  })

  describe('findAllBy', () => {
    test('should find by single value', async () => {
      const userRepo = getRepository(User)

      await userRepo.create({ username: 'alice' })
      await userRepo.create({ username: 'bob' })

      const found = await userRepo.findAllBy({
        where: { username: 'alice' },
      })

      expect(found).toBeArrayOfSize(1)
      expect(found[0]!.username).toBe('alice')
    })

    test('should find by array (IN clause)', async () => {
      const tagRepo = getRepository(Tag)

      const tag1 = await tagRepo.create({ name: 'tag1' })
      const tag2 = await tagRepo.create({ name: 'tag2' })

      await tagRepo.create({ name: 'tag3' })

      const found = await tagRepo.findAllBy({
        where: { id: [tag1.id, tag2.id] },
      })

      expect(found).toBeArrayOfSize(2)
      expect(found.map(t => t.name).sort()).toEqual(['tag1', 'tag2'])
    })

    test('should support ordering', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'charlie' })
      await tagRepo.create({ name: 'alice' })
      await tagRepo.create({ name: 'bob' })

      const found = await tagRepo.findAllBy({
        order: { name: 'ASC' },
      })

      expect(found.map(t => t.name)).toEqual(['alice', 'bob', 'charlie'])
    })

    test('should support descending order', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'charlie' })
      await tagRepo.create({ name: 'alice' })
      await tagRepo.create({ name: 'bob' })

      const found = await tagRepo.findAllBy({
        order: { name: 'DESC' },
      })

      expect(found.map(t => t.name)).toEqual(['charlie', 'bob', 'alice'])
    })

    test('should support notNull filter', async () => {
      const userRepo = getRepository(User)
      const tagRepo = getRepository(Tag)

      const tag = await tagRepo.create({ name: 'admin' })

      await userRepo.create({ username: 'with-tag', tag_id: tag.id })
      await userRepo.create({ username: 'without-tag', tag_id: null })

      const withTags = await userRepo.findAllBy({
        notNull: { tag_id: true },
      })

      expect(withTags).toBeArrayOfSize(1)
      expect(withTags[0]!.username).toBe('with-tag')
    })

    test('should combine multiple filters', async () => {
      const userRepo = getRepository(User)
      const tagRepo = getRepository(Tag)

      const tag = await tagRepo.create({ name: 'admin' })

      await userRepo.create({ username: 'user1', tag_id: tag.id })
      await userRepo.create({ username: 'user2', tag_id: tag.id })
      await userRepo.create({ username: 'user3', tag_id: null })

      const found = await userRepo.findAllBy({
        where: { tag_id: tag.id },
        order: { username: 'DESC' },
        notNull: { tag_id: true },
      })

      expect(found).toBeArrayOfSize(2)
      expect(found.map(u => u.username)).toEqual(['user2', 'user1'])
    })
  })

  describe('findOneBy', () => {
    test('should find one entity', async () => {
      const userRepo = getRepository(User)

      await userRepo.create({ username: 'alice' })
      await userRepo.create({ username: 'bob' })

      const found = await userRepo.findOneBy({
        where: { username: 'alice' },
      })

      expect(found).not.toBeNull()
      expect(found?.username).toBe('alice')
    })

    test('should return null when not found', async () => {
      const userRepo = getRepository(User)

      const found = await userRepo.findOneBy({
        where: { username: 'nonexistent' },
      })

      expect(found).toBeNull()
    })
  })

  describe('update', () => {
    test('should update an entity', async () => {
      const tagRepo = getRepository(Tag)

      const tag = await tagRepo.create({ name: 'original' })
      const updated = await tagRepo.update(tag.id, { name: 'updated' })

      expect(updated.id).toBe(tag.id)
      expect(updated.name).toBe('updated')
    })

    test('should update multiple fields', async () => {
      const tagRepo = getRepository(Tag)

      const tag = await tagRepo.create({ name: 'tag', description: null })
      const updated = await tagRepo.update(tag.id, {
        name: 'new-name',
        description: 'new description',
      })

      expect(updated.name).toBe('new-name')
      expect(updated.description).toBe('new description')
    })

    test('should throw error for non-existent entity', async () => {
      const tagRepo = getRepository(Tag)

      await expect(tagRepo.update(999999, { name: 'test' })).rejects.toThrow()
    })
  })

  describe('delete', () => {
    test('should delete an entity', async () => {
      const tagRepo = getRepository(Tag)

      const tag = await tagRepo.create({ name: 'to-delete' })

      await tagRepo.delete(tag.id)

      const found = await tagRepo.find(tag.id)

      expect(found).toBeNull()
    })
  })

  describe('persist', () => {
    test('should insert when id is not provided', async () => {
      const tagRepo = getRepository(Tag)

      const tag = await tagRepo.persist({ name: 'new-tag' })

      expect(tag.id).toBeNumber()
      expect(tag.name).toBe('new-tag')
    })

    test('should update when id is provided', async () => {
      const tagRepo = getRepository(Tag)

      const created = await tagRepo.create({ name: 'original' })
      const updated = await tagRepo.persist({
        id: created.id,
        name: 'updated',
      })

      expect(updated.id).toBe(created.id)
      expect(updated.name).toBe('updated')

      const all = await tagRepo.findAll()

      expect(all).toBeArrayOfSize(1)
    })
  })
})
