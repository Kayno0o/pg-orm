import type { InferEntity } from '../src/types'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTxRepo, getTestSchema, orm, runInTransaction, setupTestDatabase, setupTestSuite, teardownTestDatabase, teardownTestSuite, testData } from './setup'

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
  beforeAll(async () => {
    // Register repository before connecting to enable auto-migration
    orm.repo(User)
    await setupTestDatabase({ schema: getTestSchema() })
    setupTestSuite('repository')
  })

  afterAll(async () => {
    teardownTestSuite('repository')
    await teardownTestDatabase({ schema: getTestSchema() })
  })

  describe('Create', () => {
    test('should create a new entity', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
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
    })

    test('should create entity with nullable fields', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const data = {
          ...testData.user.valid(),
          age: 25,
        }
        const user = await users.create(data)

        expect(user.age).toBe(25)
      })
    })

    test('should create entity with all optional fields omitted', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const data = {
          name: 'Minimal User',
          email: testData.user.valid().email,
          role: 'user' as const,
          tags: [],
        }
        const user = await users.create(data)

        expect(user.name).toBe(data.name)
        expect(user.age).toBeNull()
        expect(user.isActive).toBe(true)
      })
    })

    test('should throw error on duplicate unique field', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const data = testData.user.valid()

        await users.create(data)

        expect(async () => {
          await users.create(data)
        }).toThrow()
      })
    })
  })

  describe('Read Operations', () => {
    test('should find entity by id', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const created = await users.create(testData.user.valid())

        const found = await users.find(created.id)

        expect(found).not.toBeNull()
        expect(found?.id).toBe(created.id)
        expect(found?.name).toBe(created.name)
        expect(found?.email).toBe(created.email)
      })
    })

    test('should return null for non-existent id', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const found = await users.find(999999)

        expect(found).toBeNull()
      })
    })

    test('should find all entities', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create(testData.user.valid())
        await users.create(testData.user.valid())
        await users.create(testData.user.valid())

        const all = await users.findAll()

        expect(all.length).toBe(3)
      })
    })

    test('should find entities by conditions', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'user' })

        const admins = await users.query().where('role', '=', 'admin').execute()

        expect(admins.length).toBe(2)
        expect(admins.every(u => u.role === 'admin')).toBe(true)
      })
    })

    test('should find one entity by conditions', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const created = await users.create(testData.user.valid())

        const found = await users.query().where('email', '=', created.email).findOne()

        expect(found).not.toBeNull()
        expect(found?.id).toBe(created.id)
      })
    })

    test('should return null when findOneBy has no match', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const found = await users.query().where('email', '=', 'nonexistent@example.com').findOne()

        expect(found).toBeNull()
      })
    })
  })

  describe('Update Operations', () => {
    test('should update entity by id', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const created = await users.create(testData.user.valid())

        const updated = await users.update(created.id, {
          name: 'Updated Name',
          age: 30,
        })

        expect(updated.name).toBe('Updated Name')
        expect(updated.age).toBe(30)
        expect(updated.email).toBe(created.email) // Unchanged
      })
    })

    test('should allow partial updates', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const created = await users.create({
          ...testData.user.valid(),
          age: 25,
        })

        const updated = await users.update(created.id, { name: 'New Name' })

        expect(updated.name).toBe('New Name')
        expect(updated.age).toBe(25) // Unchanged
        expect(updated.email).toBe(created.email) // Unchanged
      })
    })

    test('should throw error when updating non-existent entity', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        expect(async () => {
          await users.update(999999, { name: 'Test' })
        }).toThrow()
      })
    })
  })

  describe('Delete Operations', () => {
    test('should delete entity by id', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const created = await users.create(testData.user.valid())

        await users.delete(created.id)

        const found = await users.find(created.id)

        expect(found).toBeNull()
      })
    })

    test('should throw error when deleting non-existent entity', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        expect(async () => {
          await users.delete(999999)
        }).toThrow()
      })
    })
  })

  describe('Count Operations', () => {
    test('should count all entities', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create(testData.user.valid())
        await users.create(testData.user.valid())
        await users.create(testData.user.valid())

        const count = await users.count()

        expect(count).toBe(3)
      })
    })

    test('should count entities with conditions', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'user' })

        const adminCount = await users.query().where('role', '=', 'admin').count()

        expect(adminCount).toBe(2)
      })
    })
  })

  describe('Exists Operations', () => {
    test('should return true for existing entity', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const created = await users.create(testData.user.valid())

        const exists = await users.exists(created.id)

        expect(exists).toBe(true)
      })
    })

    test('should return false for non-existent entity', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const exists = await users.exists(999999)

        expect(exists).toBe(false)
      })
    })
  })

  describe('Batch Operations', () => {
    test('should create many entities', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const data = [
          testData.user.valid(),
          testData.user.valid(),
          testData.user.valid(),
        ]

        const created = await users.createMany(data)

        expect(created.length).toBe(3)
        expect(created[0]?.id).toBeGreaterThan(0)
        expect(created[1]?.id).toBeGreaterThan(0)
        expect(created[2]?.id).toBeGreaterThan(0)
      })
    })

    test('should delete many entities', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const created1 = await users.create(testData.user.valid())
        const created2 = await users.create(testData.user.valid())

        await users.deleteMany([created1.id, created2.id])

        const found1 = await users.find(created1.id)
        const found2 = await users.find(created2.id)

        expect(found1).toBeNull()
        expect(found2).toBeNull()
      })
    })
  })

  describe('Extended Repository', () => {
    test('should extend repository with custom methods', async () => {
      await runInTransaction(async (tx) => {
        const extended = orm.repo(User).withTransaction(tx).extend({
          async findByRole(this, role: 'admin' | 'user' | 'moderator'): Promise<InferEntity<typeof User.schema>[]> {
            return this.query().where('role', '=', role).execute()
          },
          async activate(this, id: number) {
            return this.update(id, { isActive: true })
          },
        })

        await extended.create({ ...testData.user.valid(), role: 'admin' })
        await extended.create({ ...testData.user.valid(), role: 'user' })

        const admins = await extended.findByRole('admin')

        expect(admins.length).toBe(1)
        expect(admins[0]?.role).toBe('admin')

        const user = await extended.create({
          ...testData.user.valid(),
          isActive: false,
        })

        const activated = await extended.activate(user.id)

        expect(activated.isActive).toBe(true)
      })
    })
  })
})
