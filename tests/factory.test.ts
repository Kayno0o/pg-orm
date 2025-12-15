import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { defineFactory } from '../src'
import { createTestTable, getTestSchema, orm, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Data Factories', () => {
  const schema = getTestSchema()

  beforeAll(async () => {
    await setupTestDatabase({ schema })
  })

  afterAll(async () => {
    await teardownTestDatabase({ schema })
  })

  describe('defineFactory', () => {
    test('should generate test data with make()', async () => {
      const User = orm.entity('factory_test_make', f => ({
        name: f.string(),
        email: f.string().unique(),
        age: f.number(),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      const userFactory = defineFactory(User, users, index => ({
        name: `User ${index}`,
        email: `user${index}@test.com`,
        age: 20 + index,
      }))

      const data = await userFactory.make(3)

      expect(data).toHaveLength(3)
      expect(data[0]!.name).toBe('User 0')
      expect(data[1]!.name).toBe('User 1')
      expect(data[2]!.name).toBe('User 2')
      expect(data[0]!.email).toBe('user0@test.com')
      expect(data[1]!.age).toBe(21)
    })

    test('should persist test data with create()', async () => {
      const User = orm.entity('factory_test_create', f => ({
        name: f.string(),
        email: f.string().unique(),
        age: f.number(),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      const userFactory = defineFactory(User, users, index => ({
        name: `User ${index}`,
        email: `user${index}@test.com`,
        age: 20 + index,
      }))

      const entities = await userFactory.create(3)

      expect(entities).toHaveLength(3)
      expect(entities[0]!.id).toBeGreaterThan(0)
      expect(entities[1]!.id).toBeGreaterThan(0)
      expect(entities[2]!.id).toBeGreaterThan(0)

      const allUsers = await users.findAll()

      expect(allUsers.length).toBeGreaterThanOrEqual(3)
    })

    test('should support makeOne()', async () => {
      const User = orm.entity('factory_test_make_one', f => ({
        name: f.string(),
        email: f.string(),
        age: f.number(),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      const userFactory = defineFactory(User, users, index => ({
        name: `User ${index}`,
        email: `user${index}@test.com`,
        age: 20 + index,
      }))

      const data = await userFactory.makeOne()

      expect(data.name).toBe('User 0')
      expect(data.email).toBe('user0@test.com')
      expect(data.age).toBe(20)
    })

    test('should support createOne()', async () => {
      const User = orm.entity('factory_test_create_one', f => ({
        name: f.string(),
        email: f.string().unique(),
        age: f.number(),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      const userFactory = defineFactory(User, users, index => ({
        name: `User ${index}`,
        email: `user${index}@test.com`,
        age: 20 + index,
      }))

      const user = await userFactory.createOne()

      expect(user.id).toBeGreaterThan(0)
      expect(user.name).toBe('User 0')
      expect(user.email).toBe('user0@test.com')

      const allUsers = await users.findAll()

      expect(allUsers).toHaveLength(1)
    })

    test('should support state overrides', async () => {
      const User = orm.entity('factory_test_state', f => ({
        name: f.string(),
        email: f.string().unique(),
        age: f.number(),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      const userFactory = defineFactory(User, users, index => ({
        name: `User ${index}`,
        email: `user${index}@test.com`,
        age: 20 + index,
      }))

      const data = await userFactory.state({ age: 50 }).make(3)

      expect(data[0]!.age).toBe(50)
      expect(data[1]!.age).toBe(50)
      expect(data[2]!.age).toBe(50)
    })

    test('should support async generators', async () => {
      const User = orm.entity('factory_test_async', f => ({
        name: f.string(),
        email: f.string(),
        age: f.number(),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      const userFactory = defineFactory(User, users, async (index) => {
        await new Promise(resolve => setTimeout(resolve, 10))

        return {
          name: `User ${index}`,
          email: `user${index}@test.com`,
          age: 20 + index,
        }
      })

      const data = await userFactory.make(2)

      expect(data).toHaveLength(2)
      expect(data[0]!.name).toBe('User 0')
      expect(data[1]!.name).toBe('User 1')
    })

    test('should expose raw generator', async () => {
      const User = orm.entity('factory_test_raw', f => ({
        name: f.string(),
        email: f.string(),
        age: f.number(),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      const userFactory = defineFactory(User, users, index => ({
        name: `User ${index}`,
        email: `user${index}@test.com`,
        age: 20 + index,
      }))

      const generator = userFactory.raw()

      expect(typeof generator).toBe('function')

      const data = await Promise.resolve(generator(5))

      expect(data.name).toBe('User 5')
      expect(data.age).toBe(25)
    })
  })
})
