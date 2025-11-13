import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getDB, getRepository, QueryBuilder } from '../src'
import { Tag } from './entities/Tag'
import { User } from './entities/User'
import { cleanTables, createTables, setupTestDB, teardownTestDB } from './setup'

describe('QueryBuilder', () => {
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

  describe('basic queries', () => {
    test('should select all', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })

      const qb = new QueryBuilder<Tag>('tag')
      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(2)
    })

    test('should select specific fields', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1', description: 'desc1' })

      const qb = new QueryBuilder('tag')

      qb.select('name')

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(1)
      expect(results[0]).toHaveProperty('name')
    })

    test('should use where clause', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.whereEquals('name', 'tag1')

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(1)
      expect(results[0]!.name).toBe('tag1')
    })

    test('should chain multiple where clauses', async () => {
      const userRepo = getRepository(User)

      await userRepo.create({ username: 'user1', active: true })
      await userRepo.create({ username: 'user2', active: false })
      await userRepo.create({ username: 'user3', active: true })

      const qb = new QueryBuilder<User>('user')

      qb.whereEquals('active', true).whereLike('username', 'user%')

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(2)
    })
  })

  describe('joins', () => {
    test('should perform LEFT JOIN', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)

      const tag = await tagRepo.create({ name: 'admin' })

      await userRepo.create({ username: 'user1', tag_id: tag.id })
      await userRepo.create({ username: 'user2', tag_id: null })

      const qb = new QueryBuilder('user', 'u')

      qb.select('u.username', 't.name as tag_name').leftJoin(
        'tag',
        't',
        'u.tag_id = t.id',
      )

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(2)
      expect(results[0]).toHaveProperty('tag_name')
    })

    test('should perform INNER JOIN', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)

      const tag = await tagRepo.create({ name: 'admin' })

      await userRepo.create({ username: 'user1', tag_id: tag.id })
      await userRepo.create({ username: 'user2', tag_id: null })

      const qb = new QueryBuilder<{ username: string, tag_name: string }>('user', 'u')

      qb.select('u.username', 't.name as tag_name').join(
        'tag',
        't',
        'u.tag_id = t.id',
      )

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(1)
      expect(results[0]!.username).toBe('user1')
    })
  })

  describe('ordering', () => {
    test('should order ascending', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'charlie' })
      await tagRepo.create({ name: 'alice' })
      await tagRepo.create({ name: 'bob' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.order('name', 'asc')

      const results = await qb.findAll()

      expect(results.map(t => t.name)).toEqual(['alice', 'bob', 'charlie'])
    })

    test('should order descending', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'charlie' })
      await tagRepo.create({ name: 'alice' })
      await tagRepo.create({ name: 'bob' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.order('name', 'desc')

      const results = await qb.findAll()

      expect(results.map(t => t.name)).toEqual(['charlie', 'bob', 'alice'])
    })
  })

  describe('limit and offset', () => {
    test('should limit results', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })
      await tagRepo.create({ name: 'tag3' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.limit(2)

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(2)
    })

    test('should offset results', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })
      await tagRepo.create({ name: 'tag3' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.order('id', 'asc').offset(1).limit(2)

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(2)
      expect(results[0]!.name).toBe('tag2')
    })
  })

  describe('groupBy and having', () => {
    test('should group by field', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)

      const tag1 = await tagRepo.create({ name: 'tag1' })
      const tag2 = await tagRepo.create({ name: 'tag2' })

      await userRepo.create({ username: 'user1', tag_id: tag1.id })
      await userRepo.create({ username: 'user2', tag_id: tag1.id })
      await userRepo.create({ username: 'user3', tag_id: tag2.id })

      const qb = new QueryBuilder<{ tag_id: number, count: number }>('user')

      qb.select('tag_id', 'COUNT(*)::int as count').groupBy('tag_id').order('tag_id', 'asc')

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(2)
      expect(results[0]!.count).toBe(2)
      expect(results[1]!.count).toBe(1)
    })

    test('should filter with having clause', async () => {
      const tagRepo = getRepository(Tag)
      const userRepo = getRepository(User)
      const db = getDB()

      const tag1 = await tagRepo.create({ name: 'tag1' })
      const tag2 = await tagRepo.create({ name: 'tag2' })

      await userRepo.create({ username: 'user1', tag_id: tag1.id })
      await userRepo.create({ username: 'user2', tag_id: tag1.id })
      await userRepo.create({ username: 'user3', tag_id: tag2.id })

      const qb = new QueryBuilder<{ tag_id: number, count: number }>('user')

      qb.select('tag_id', 'COUNT(*)::int as count')
        .groupBy('tag_id')
        .having(db`COUNT(*) > ${1}`)

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(1)
      expect(results[0]!.count).toBe(2)
    })
  })

  describe('findOne', () => {
    test('should return first result', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.whereEquals('name', 'tag1')

      const result = await qb.findOne()

      expect(result).not.toBeNull()
      expect(result?.name).toBe('tag1')
    })

    test('should return null when not found', async () => {
      const qb = new QueryBuilder<Tag>('tag')

      qb.whereEquals('name', 'nonexistent')

      const result = await qb.findOne()

      expect(result).toBeNull()
    })
  })

  describe('count', () => {
    test('should count all rows', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'tag1' })
      await tagRepo.create({ name: 'tag2' })
      await tagRepo.create({ name: 'tag3' })

      const qb = new QueryBuilder<Tag>('tag')
      const count = await qb.count()

      expect(count).toBe(3)
    })

    test('should count with where clause', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'test1' })
      await tagRepo.create({ name: 'test2' })
      await tagRepo.create({ name: 'other' })

      const qb = new QueryBuilder<Tag>('tag')

      qb.whereLike('name', 'test%')

      const count = await qb.count()

      expect(count).toBe(2)
    })
  })

  describe('build', () => {
    test('should build and execute query correctly', async () => {
      const tagRepo = getRepository(Tag)

      await tagRepo.create({ name: 'test' })
      await tagRepo.create({ name: 'other' })

      const qb = new QueryBuilder<Tag>('tag', 't')

      qb.select('t.id', 't.name')
        .whereEquals('t.name', 'test')
        .order('t.id', 'desc')
        .limit(10)

      const fragment = qb.build()

      expect(fragment).toBeDefined()

      const results = await qb.findAll()

      expect(results).toBeArrayOfSize(1)
      expect(results[0]!.name).toBe('test')
    })
  })
})
