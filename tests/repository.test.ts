import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import { cleanupTables, setupTestDatabase, teardownTestDatabase, testData } from './setup'

// Test entity definition
const User = orm.entity('test_users', {
  name: orm.string(),
  email: orm.string().unique(),
  age: orm.number().nullable(),
  role: orm.enum(['admin', 'user', 'moderator'] as const),
  isActive: orm.boolean().default(true),
  tags: orm.array('string'),
}).build()

describe('Repository CRUD Operations', () => {
  let users: ReturnType<typeof orm.repo<typeof User.schema>>

  beforeAll(async () => {
    // Register repository before connecting to enable auto-migration
    users = orm.repo(User)
    await setupTestDatabase()
  })

  afterAll(async () => {
    await cleanupTables('test_users')
    await teardownTestDatabase()
  })

  describe('Create', () => {
    test('should create a new entity', async () => {
      const data = testData.user.valid()
      const user = await users.create(data)

      expect(user.id).toBeGreaterThan(0)
      expect(user.name).toBe(data.name)
      expect(user.email).toBe(data.email)
      expect(user.role).toBe(data.role)
      expect(user.tags).toEqual(data.tags)
      expect(user.isActive).toBe(true) // Default value
      expect(user.age).toBeNull()
    })

    test('should create entity with nullable fields', async () => {
      const data = {
        ...testData.user.valid(),
        email: 'withnull@example.com',
        age: 25,
      }
      const user = await users.create(data)

      expect(user.age).toBe(25)
    })

    test('should create entity with all optional fields omitted', async () => {
      const data = {
        name: 'Minimal User',
        email: 'minimal@example.com',
        role: 'user' as const,
        tags: [],
      }
      const user = await users.create(data)

      expect(user.name).toBe(data.name)
      expect(user.age).toBeNull()
      expect(user.isActive).toBe(true)
    })

    test('should throw error on duplicate unique field', async () => {
      const data = {
        ...testData.user.valid(),
        email: 'duplicate-test@example.com',
      }

      await users.create(data)

      await expect(async () => {
        await users.create(data)
      }).toThrow()
    })
  })

  describe('Read Operations', () => {
    test('should find entity by id', async () => {
      const created = await users.create({
        ...testData.user.valid(),
        email: 'find@example.com',
      })

      const found = await users.find(created.id)

      expect(found).not.toBeNull()
      expect(found?.id).toBe(created.id)
      expect(found?.name).toBe(created.name)
      expect(found?.email).toBe(created.email)
    })

    test('should return null for non-existent id', async () => {
      const found = await users.find(999999)

      expect(found).toBeNull()
    })

    test('should find all entities', async () => {
      // Clean up first
      const db = orm.getDB()

      await db`DELETE FROM test_users`

      await users.create({ ...testData.user.valid(), email: 'user1@example.com' })
      await users.create({ ...testData.user.valid(), email: 'user2@example.com' })
      await users.create({ ...testData.user.valid(), email: 'user3@example.com' })

      const all = await users.findAll()

      expect(all.length).toBeGreaterThanOrEqual(3)
    })

    test('should find entities by conditions', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_users`

      await users.create({ ...testData.user.valid(), email: 'admin1@example.com', role: 'admin' })
      await users.create({ ...testData.user.valid(), email: 'admin2@example.com', role: 'admin' })
      await users.create({ ...testData.user.valid(), email: 'user1@example.com', role: 'user' })

      const admins = await users.findBy({ where: { role: 'admin' } })

      expect(admins.length).toBe(2)
      expect(admins.every(u => u.role === 'admin')).toBe(true)
    })

    test('should find one entity by conditions', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_users`

      const created = await users.create({
        ...testData.user.valid(),
        email: 'findone@example.com',
      })

      const found = await users.findOneBy({ where: { email: 'findone@example.com' } })

      expect(found).not.toBeNull()
      expect(found?.id).toBe(created.id)
    })

    test('should return null when findOneBy has no match', async () => {
      const found = await users.findOneBy({ where: { email: 'nonexistent@example.com' } })

      expect(found).toBeNull()
    })
  })

  describe('Update Operations', () => {
    test('should update entity by id', async () => {
      const created = await users.create({
        ...testData.user.valid(),
        email: 'toupdate@example.com',
      })

      const updated = await users.update(created.id, {
        name: 'Updated Name',
        age: 30,
      })

      expect(updated.name).toBe('Updated Name')
      expect(updated.age).toBe(30)
      expect(updated.email).toBe(created.email) // Unchanged
    })

    test('should allow partial updates', async () => {
      const created = await users.create({
        ...testData.user.valid(),
        email: 'partial@example.com',
        age: 25,
      })

      const updated = await users.update(created.id, { name: 'New Name' })

      expect(updated.name).toBe('New Name')
      expect(updated.age).toBe(25) // Unchanged
      expect(updated.email).toBe(created.email) // Unchanged
    })

    test('should throw error when updating non-existent entity', async () => {
      await expect(async () => {
        await users.update(999999, { name: 'Test' })
      }).toThrow()
    })
  })

  describe('Delete Operations', () => {
    test('should delete entity by id', async () => {
      const created = await users.create({
        ...testData.user.valid(),
        email: 'todelete@example.com',
      })

      await users.delete(created.id)

      const found = await users.find(created.id)

      expect(found).toBeNull()
    })

    test('should throw error when deleting non-existent entity', async () => {
      await expect(async () => {
        await users.delete(999999)
      }).toThrow()
    })
  })

  describe('Count Operations', () => {
    test('should count all entities', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_users`

      await users.create({ ...testData.user.valid(), email: 'count1@example.com' })
      await users.create({ ...testData.user.valid(), email: 'count2@example.com' })
      await users.create({ ...testData.user.valid(), email: 'count3@example.com' })

      const count = await users.count()

      expect(count).toBe(3)
    })

    test('should count entities with conditions', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_users`

      await users.create({ ...testData.user.valid(), email: 'count-admin1@example.com', role: 'admin' })
      await users.create({ ...testData.user.valid(), email: 'count-admin2@example.com', role: 'admin' })
      await users.create({ ...testData.user.valid(), email: 'count-user1@example.com', role: 'user' })

      const adminCount = await users.count({ where: { role: 'admin' } })

      expect(adminCount).toBe(2)
    })
  })

  describe('Exists Operations', () => {
    test('should return true for existing entity', async () => {
      const created = await users.create({
        ...testData.user.valid(),
        email: 'exists@example.com',
      })

      const exists = await users.exists(created.id)

      expect(exists).toBe(true)
    })

    test('should return false for non-existent entity', async () => {
      const exists = await users.exists(999999)

      expect(exists).toBe(false)
    })
  })

  describe('Pagination', () => {
    test('should paginate results', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_users`

      // Create 10 users
      for (let i = 0; i < 10; i++) {
        await users.create({
          ...testData.user.valid(),
          email: `page${i}@example.com`,
          name: `User ${i}`,
        })
      }

      const page1 = await users.paginate({ page: 1, pageSize: 5 })

      expect(page1.data.length).toBe(5)
      expect(page1.total).toBe(10)
      expect(page1.page).toBe(1)
      expect(page1.pageSize).toBe(5)
      expect(page1.totalPages).toBe(2)
    })

    test('should paginate with where conditions', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_users`

      for (let i = 0; i < 6; i++) {
        await users.create({
          ...testData.user.valid(),
          email: `pagecond${i}@example.com`,
          role: i % 2 === 0 ? 'admin' : 'user',
        })
      }

      const page = await users.paginate({
        page: 1,
        pageSize: 2,
        where: { role: 'admin' },
      })

      expect(page.data.length).toBe(2)
      expect(page.total).toBe(3) // 3 admins total
      expect(page.data.every(u => u.role === 'admin')).toBe(true)
    })

    test('should paginate with order', async () => {
      const db = orm.getDB()

      await db`DELETE FROM test_users`

      await users.create({ ...testData.user.valid(), email: 'c@example.com', name: 'Charlie' })
      await users.create({ ...testData.user.valid(), email: 'a@example.com', name: 'Alice' })
      await users.create({ ...testData.user.valid(), email: 'b@example.com', name: 'Bob' })

      const page = await users.paginate({
        page: 1,
        pageSize: 10,
        order: { name: 'ASC' },
      })

      expect(page.data[0]?.name).toBe('Alice')
      expect(page.data[1]?.name).toBe('Bob')
      expect(page.data[2]?.name).toBe('Charlie')
    })
  })

  describe('Batch Operations', () => {
    test('should create many entities', async () => {
      const data = [
        { ...testData.user.valid(), email: 'batch1@example.com' },
        { ...testData.user.valid(), email: 'batch2@example.com' },
        { ...testData.user.valid(), email: 'batch3@example.com' },
      ]

      const created = await users.createMany(data)

      expect(created.length).toBe(3)
      expect(created[0]?.id).toBeGreaterThan(0)
      expect(created[1]?.id).toBeGreaterThan(0)
      expect(created[2]?.id).toBeGreaterThan(0)
    })

    test('should delete many entities', async () => {
      const created1 = await users.create({ ...testData.user.valid(), email: 'delmany1@example.com' })
      const created2 = await users.create({ ...testData.user.valid(), email: 'delmany2@example.com' })

      await users.deleteMany([created1.id, created2.id])

      const found1 = await users.find(created1.id)
      const found2 = await users.find(created2.id)

      expect(found1).toBeNull()
      expect(found2).toBeNull()
    })
  })

  describe('Extended Repository', () => {
    test('should extend repository with custom methods', async () => {
      const extended = orm.repo(User).extend({
        async findByRole(this, role: 'admin' | 'user' | 'moderator') {
          return this.findBy({ where: { role } })
        },
        async activate(this, id: number) {
          return this.update(id, { isActive: true })
        },
      })

      const db = orm.getDB()

      await db`DELETE FROM test_users`

      await extended.create({ ...testData.user.valid(), email: 'ext1@example.com', role: 'admin' })
      await extended.create({ ...testData.user.valid(), email: 'ext2@example.com', role: 'user' })

      const admins = await extended.findByRole('admin')

      expect(admins.length).toBe(1)
      expect(admins[0]?.role).toBe('admin')

      const user = await extended.create({
        ...testData.user.valid(),
        email: 'ext3@example.com',
        isActive: false,
      })

      const activated = await extended.activate(user.id)

      expect(activated.isActive).toBe(true)
    })
  })
})
