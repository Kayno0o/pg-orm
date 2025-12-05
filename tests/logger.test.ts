import type { QueryLogEntry } from '../src/logger'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm, queryLogger } from '../src'
import {
  createTxRepo,
  runInTransaction,
  setupTestDatabase,
  setupTestSuite,
  teardownTestDatabase,
  teardownTestSuite,
  testData,
} from './setup'

const User = orm.entity('test_logger_users', {
  name: orm.string(),
  email: orm.string(),
  age: orm.number().nullable(),
}).build()

describe('Query Logger', () => {
  beforeAll(async () => {
    orm.repo(User)
    await setupTestDatabase()
    setupTestSuite('logger')
  })

  afterAll(async () => {
    teardownTestSuite('logger')
    await teardownTestDatabase()
  })

  test('should log query execution in QueryBuilder.execute()', async () => {
    let loggedEntry: QueryLogEntry | undefined

    queryLogger.configure({
      enabled: true,
      logger: (entry) => {
        loggedEntry = entry
      },
    })

    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await users.create(testData.user.valid())

      await users.query().where('name', '=', 'Alice').execute()

      expect(loggedEntry).toBeDefined()
      expect(loggedEntry?.operation).toBe('SELECT')
      expect(loggedEntry?.table).toBe('test_logger_users')
      expect(loggedEntry?.query).toContain('SELECT')
      expect(loggedEntry?.query).toContain('test_logger_users')
      expect(loggedEntry?.duration).toBeGreaterThanOrEqual(0)
      expect(loggedEntry?.timestamp).toBeInstanceOf(Date)
    })

    queryLogger.configure({ enabled: false })
  })

  test('should log query execution in QueryBuilder.random()', async () => {
    let loggedEntry: QueryLogEntry | undefined

    queryLogger.configure({
      enabled: true,
      logger: (entry) => {
        loggedEntry = entry
      },
    })

    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await users.create(testData.user.valid())

      await users.query().random(1)

      expect(loggedEntry).toBeDefined()
      expect(loggedEntry?.operation).toBe('SELECT')
      expect(loggedEntry?.table).toBe('test_logger_users')
      expect(loggedEntry?.query).toContain('RANDOM()')
    })

    queryLogger.configure({ enabled: false })
  })

  test('should log query execution in Repository.exists()', async () => {
    let loggedEntry: QueryLogEntry | undefined

    queryLogger.configure({
      enabled: true,
      logger: (entry) => {
        loggedEntry = entry
      },
    })

    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      const user = await users.create(testData.user.valid())

      await users.exists(user.id)

      expect(loggedEntry).toBeDefined()
      expect(loggedEntry?.operation).toBe('SELECT')
      expect(loggedEntry?.table).toBe('test_logger_users')
      expect(loggedEntry?.query).toContain('SELECT 1')
    })

    queryLogger.configure({ enabled: false })
  })

  test('should log query execution in Repository.deleteMany()', async () => {
    let loggedEntry: QueryLogEntry | undefined

    queryLogger.configure({
      enabled: true,
      logger: (entry) => {
        loggedEntry = entry
      },
    })

    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      const user1 = await users.create(testData.user.valid())
      const user2 = await users.create(testData.user.valid())

      await users.deleteMany([user1.id, user2.id])

      expect(loggedEntry).toBeDefined()
      expect(loggedEntry?.operation).toBe('DELETE')
      expect(loggedEntry?.table).toBe('test_logger_users')
      expect(loggedEntry?.query).toContain('DELETE FROM')
    })

    queryLogger.configure({ enabled: false })
  })

  test('should log repository operations with query params', async () => {
    const loggedEntries: QueryLogEntry[] = []

    queryLogger.configure({
      enabled: true,
      logger: (entry) => {
        loggedEntries.push(entry)
      },
    })

    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      // Create operations should be logged with INSERT
      await users.create(testData.user.valid())

      // Find operations should be logged with SELECT
      await users.findAll()

      // All operations should be logged
      expect(loggedEntries.length).toBeGreaterThanOrEqual(2)

      // Check that INSERT was logged
      const insertEntry = loggedEntries.find(e => e.operation === 'INSERT')

      expect(insertEntry).toBeDefined()
      expect(insertEntry?.table).toBe('test_logger_users')
      expect(insertEntry?.params).toBeDefined()

      // Check that SELECT was logged
      const selectEntry = loggedEntries.find(e => e.operation === 'SELECT')

      expect(selectEntry).toBeDefined()
      expect(selectEntry?.table).toBe('test_logger_users')
    })

    queryLogger.configure({ enabled: false })
  })

  test('should log successful queries without errors', async () => {
    let loggedEntry: QueryLogEntry | undefined

    queryLogger.configure({
      enabled: true,
      logger: (entry) => {
        loggedEntry = entry
      },
    })

    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await users.create(testData.user.valid())

      await users.query().where('name', '=', 'Alice').execute()

      expect(loggedEntry).toBeDefined()
      expect(loggedEntry?.error).toBeUndefined()
    })

    queryLogger.configure({ enabled: false })
  })

  test('should not log when disabled', async () => {
    let loggedEntry: QueryLogEntry | undefined

    queryLogger.configure({
      enabled: false,
      logger: (entry) => {
        loggedEntry = entry
      },
    })

    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await users.create(testData.user.valid())

      await users.query().execute()

      expect(loggedEntry).toBeUndefined()
    })
  })
})
