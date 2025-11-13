import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getRepository, QueryBuilder } from '../src'
import { Tag } from './entities/Tag'
import { User } from './entities/User'
import { cleanTables, createTables, setupTestDB, teardownTestDB } from './setup'

describe('QueryBuilder Advanced Methods', () => {
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

  describe('whereIn', () => {
    test('should filter by IN clause', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })
      await tagRepo.create({ name: 'tag3' })
      await tagRepo.create({ name: 'other' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.whereIn('name', ['tag1', 'tag2', 'tag3'])

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(3)
      expect(results.every(t => t.name.startsWith('tag'))).toBe(true)
    })

    test('should handle single value array', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.whereIn('name', ['tag1'])

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(1)
      expect(results[0]!.name).toBe('tag1')
    })
  })

  describe('whereNotIn', () => {
    test('should exclude values with NOT IN', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })
      await tagRepo.create({ name: 'excluded' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.whereNotIn('name', ['excluded'])

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(2)
      expect(results.every(t => t.name !== 'excluded')).toBe(true)
    })
  })

  describe('whereBetween', () => {
    test('should filter by range with BETWEEN', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      const tag2 = await tagRepo.create({ name: 'tag2' })
      const tag3 = await tagRepo.create({ name: 'tag3' })

      await tagRepo.create({ name: 'tag4' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.whereBetween('id', tag2.id, tag3.id)

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(2)
      expect(results.map(t => t.id)).toEqual([tag2.id, tag3.id])
    })
  })

  describe('whereNull / whereNotNull', () => {
    test('should filter NULL values with whereNull', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)

      const tag = await tagRepo.create({ name: 'test' })

      await userRepo.create({ username: 'with-tag', tag_id: tag.id })
      await userRepo.create({ username: 'without-tag', tag_id: null })

      const qb = new QueryBuilder<User>('user')

      qb.whereNull('tag_id')

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(1)
      expect(results[0]!.username).toBe('without-tag')
    })

    test('should filter NOT NULL values with whereNotNull', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)

      const tag = await tagRepo.create({ name: 'test' })

      await userRepo.create({ username: 'with-tag', tag_id: tag.id })
      await userRepo.create({ username: 'without-tag', tag_id: null })

      const qb = new QueryBuilder<User>('user')

      qb.whereNotNull('tag_id')

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(1)
      expect(results[0]!.username).toBe('with-tag')
    })
  })

  describe('whereLike / whereILike', () => {
    test('should filter with LIKE pattern', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'test-one' })
      await tagRepo.create({ name: 'test-two' })
      await tagRepo.create({ name: 'other' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.whereLike('name', 'test%')

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(2)
      expect(results.every(t => t.name.startsWith('test'))).toBe(true)
    })

    test('should filter case-insensitive with ILIKE', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'TEST' })
      await tagRepo.create({ name: 'Test' })
      await tagRepo.create({ name: 'test' })
      await tagRepo.create({ name: 'other' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.whereILike('name', 'test%')

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(3)
    })
  })

  describe('ordering methods', () => {
    test('should order descending with orderByDesc', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'a' })
      await tagRepo.create({ name: 'b' })
      await tagRepo.create({ name: 'c' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.orderByDesc('name')

      const results = await qb.findAll()

      expect(results.map(t => t.name)).toEqual(['c', 'b', 'a'])
    })

    test('should get latest record', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'first' })
      await tagRepo.create({ name: 'second' })
      const third = await tagRepo.create({ name: 'third' })

      const qb = new QueryBuilder<Tag>('tag')
      const latest = await qb.latest('id')

      expect(latest).not.toBeNull()
      expect(latest!.id).toBe(third.id)
    })

    test('should get oldest record', async () => {
      const tagRepo = getRepository(Tag)

      const first = await tagRepo.create({ name: 'first' })

      await tagRepo.create({ name: 'second' })
      await tagRepo.create({ name: 'third' })

      const qb = new QueryBuilder<Tag>('tag')
      const oldest = await qb.oldest('id')

      expect(oldest).not.toBeNull()
      expect(oldest!.id).toBe(first.id)
    })

    test('should get random records', async () => {
      const tagRepo = getRepository(Tag)

      for (let i = 0; i < 10; i++) {
        await tagRepo.create({ name: `tag${i}` })
      }

      const qb = new QueryBuilder<Tag>('tag')

      qb.random(3)

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(3)
    })

    test('should return null for latest/oldest on empty table', async () => {
      const qb = new QueryBuilder<Tag>('tag')

      const latest = await qb.latest('id')
      const oldest = await qb.oldest('id')

      expect(latest).toBeNull()
      expect(oldest).toBeNull()
    })
  })

  describe('chaining multiple conditions', () => {
    test('should chain multiple where clauses', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)

      const tag = await tagRepo.create({ name: 'admin' })

      await userRepo.create({ username: 'active-admin', active: true, tag_id: tag.id })
      await userRepo.create({ username: 'active-user', active: true, tag_id: null })
      await userRepo.create({ username: 'inactive-admin', active: false, tag_id: tag.id })

      const qb = new QueryBuilder<User>('user')

      qb.whereEquals('active', true)
        .whereNotNull('tag_id')
        .orderByDesc('username')

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(1)
      expect(results[0]!.username).toBe('active-admin')
    })

    test('should combine whereIn with other conditions', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1', description: 'desc' })
      await tagRepo.create({ name: 'tag2', description: 'desc' })
      await tagRepo.create({ name: 'tag3', description: null })

      const qb = new QueryBuilder<Tag>('tag')

      qb.whereIn('name', ['tag1', 'tag2', 'tag3'])
        .whereNotNull('description')

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(2)
    })
  })

  describe('limit and offset', () => {
    beforeEach(async () => {
      const tagRepo = getRepository(Tag)

      for (let i = 1; i <= 20; i++) {
        await tagRepo.create({ name: `tag${i}` })
      }
    })

    test('should limit results', async () => {
      const qb = new QueryBuilder<Tag>('tag')

      qb.limit(5)

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(5)
    })

    test('should offset results', async () => {
      const qb = new QueryBuilder<Tag>('tag')

      qb.order('name', 'asc').offset(10).limit(5)

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(5)
    })

    test('should combine limit and offset for pagination', async () => {
      const page1 = new QueryBuilder<Tag>('tag')

      page1.order('name', 'asc').limit(10).offset(0)

      const page2 = new QueryBuilder<Tag>('tag')

      page2.order('name', 'asc').limit(10).offset(10)

      const results1 = await page1.findAll()
      const results2 = await page2.findAll()

      expect(results1).toBeArrayOfSize(10)
      expect(results2).toBeArrayOfSize(10)
      expect(results1[0]!.name).not.toBe(results2[0]!.name)
    })
  })

  describe('build method', () => {
    test('should return SQLFragment for inspection', async () => {
      const qb = new QueryBuilder<Tag>('tag')

      qb.whereEquals('name', 'test').limit(5)

      const fragment = qb.build()

      expect(fragment).toBeDefined()
      expect(typeof fragment).toBe('object')
    })
  })
})
