import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import {
  createTxRepo,
  runInTransaction,
  setupTestDatabase,
  setupTestSuite,
  teardownTestDatabase,
  teardownTestSuite,
  testData,
} from './setup'

describe('Projections/Select', () => {
  const User = orm
    .entity('projection_users', {
      name: orm.string(),
      email: orm.string(),
      age: orm.number(),
      role: orm.enum(['admin', 'user'] as const),
    })
    .build()

  beforeAll(async () => {
    orm.repo(User)
    await setupTestDatabase()
    setupTestSuite('projections')
  })

  afterAll(async () => {
    teardownTestSuite('projections')
    await teardownTestDatabase()
  })

  test('should select specific fields via query builder', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)
      const user = await users.create({
        name: 'Alice',
        email: testData.user.valid().email,
        age: 25,
        role: 'admin',
      })

      const projected = await users.query()
        .select('id', 'name')
        .where('id', '=', user.id)
        .execute()

      expect(projected).toHaveLength(1)
      expect(projected[0]!.id).toBe(user.id)
      expect(projected[0]!.name).toBe('Alice')
      expect(projected[0]!).not.toHaveProperty('email')
      expect(projected[0]!).not.toHaveProperty('age')
    })
  })

  test('should select fields via repository shorthand', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await users.create({
        name: 'Bob',
        email: testData.user.valid().email,
        age: 30,
        role: 'user',
      })

      const projected = await users.select('name', 'role').execute()

      expect(projected.length).toBeGreaterThan(0)
      expect(projected[0]).toHaveProperty('name')
      expect(projected[0]).toHaveProperty('role')
      expect(projected[0]).not.toHaveProperty('email')
      expect(projected[0]).not.toHaveProperty('age')
    })
  })

  test('should work with where clauses', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await users.create({
        name: 'Admin1',
        email: testData.user.valid().email,
        age: 30,
        role: 'admin',
      })
      await users.create({
        name: 'User1',
        email: testData.user.valid().email,
        age: 25,
        role: 'user',
      })

      const admins = await users.select('id', 'name', 'role')
        .where('role', '=', 'admin')
        .execute()

      expect(admins.length).toBeGreaterThan(0)
      for (const admin of admins) {
        expect(admin.role).toBe('admin')
        expect(admin).toHaveProperty('id')
        expect(admin).toHaveProperty('name')
        expect(admin).not.toHaveProperty('email')
      }
    })
  })

  test('should work with ordering and limits', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await users.create({ name: 'Alice', email: testData.user.valid().email, age: 25, role: 'user' })
      await users.create({ name: 'Bob', email: testData.user.valid().email, age: 30, role: 'user' })
      await users.create({ name: 'Charlie', email: testData.user.valid().email, age: 28, role: 'user' })
      await users.create({ name: 'Diana', email: testData.user.valid().email, age: 32, role: 'admin' })

      const top3 = await users.select('id', 'name')
        .orderBy('name', 'ASC')
        .limit(3)
        .execute()

      expect(top3.length).toBeLessThanOrEqual(3)
      for (const user of top3) {
        expect(user).toHaveProperty('id')
        expect(user).toHaveProperty('name')
        expect(user).not.toHaveProperty('email')
      }
    })
  })

  test('should select all fields with explicit id', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await users.create({
        name: 'Charlie',
        email: testData.user.valid().email,
        age: 28,
        role: 'user',
      })

      const allFields = await users.query()
        .select('id', 'name', 'email', 'age', 'role')
        .limit(1)
        .execute()

      expect(allFields).toHaveLength(1)
      expect(allFields[0]).toHaveProperty('id')
      expect(allFields[0]).toHaveProperty('name')
      expect(allFields[0]).toHaveProperty('email')
      expect(allFields[0]).toHaveProperty('age')
      expect(allFields[0]).toHaveProperty('role')
    })
  })

  test('should work with findOne', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)
      const user = await users.create({
        name: 'Diana',
        email: testData.user.valid().email,
        age: 32,
        role: 'admin',
      })

      const projected = await users.query()
        .select('id', 'name')
        .where('id', '=', user.id)
        .findOne()

      expect(projected).not.toBeNull()
      expect(projected!.id).toBe(user.id)
      expect(projected!.name).toBe('Diana')
      expect(projected).not.toHaveProperty('email')
    })
  })

  test('should return null when no results with findOne', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)
      const projected = await users.query()
        .select('id', 'name')
        .where('id', '=', 999999)
        .findOne()

      expect(projected).toBeNull()
    })
  })
})
