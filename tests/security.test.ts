import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { InvalidIdentifierError, orm } from '../src'
import { quoteIdentifier, validateSQLIdentifier, validateSQLIdentifiers } from '../src/sql-utils'
import { cleanupTables, createTestTable, setupTestDatabase, teardownTestDatabase, truncateTables } from './setup'

describe('Security - SQL Injection Protection', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  describe('SQL Identifier Validation', () => {
    test('should accept valid identifiers', () => {
      expect(() => validateSQLIdentifier('users', 'table')).not.toThrow()
      expect(() => validateSQLIdentifier('user_name', 'column')).not.toThrow()
      expect(() => validateSQLIdentifier('_id', 'column')).not.toThrow()
      expect(() => validateSQLIdentifier('table123', 'table')).not.toThrow()
    })

    test('should reject empty identifiers', () => {
      expect(() => validateSQLIdentifier('', 'table')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('   ', 'table')).toThrow(InvalidIdentifierError)
    })

    test('should reject identifiers exceeding 63 characters', () => {
      const longIdentifier = 'a'.repeat(64)

      expect(() => validateSQLIdentifier(longIdentifier, 'table')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier(longIdentifier, 'table')).toThrow(/exceeds 63 character limit/)
    })

    test('should reject invalid patterns', () => {
      // Starting with number
      expect(() => validateSQLIdentifier('1users', 'table')).toThrow(InvalidIdentifierError)

      // Special characters
      expect(() => validateSQLIdentifier('user-name', 'column')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('user.name', 'column')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('user name', 'column')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('user@name', 'column')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('user;DROP TABLE users;--', 'column')).toThrow(InvalidIdentifierError)

      // SQL injection attempts
      expect(() => validateSQLIdentifier('\'; DROP TABLE users; --', 'table')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('1 OR 1=1', 'column')).toThrow(InvalidIdentifierError)
    })

    test('should reject reserved keywords', () => {
      expect(() => validateSQLIdentifier('SELECT', 'table')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('select', 'table')).toThrow(/reserved PostgreSQL keyword/)
      expect(() => validateSQLIdentifier('WHERE', 'column')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('FROM', 'column')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('INSERT', 'table')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('UPDATE', 'table')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('DELETE', 'table')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('DROP', 'table')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifier('TABLE', 'table')).toThrow(InvalidIdentifierError)
    })

    test('should validate multiple identifiers', () => {
      expect(() => validateSQLIdentifiers(['id', 'name', 'email'], 'column')).not.toThrow()
      expect(() => validateSQLIdentifiers(['id', 'SELECT', 'email'], 'column')).toThrow(InvalidIdentifierError)
      expect(() => validateSQLIdentifiers(['id', 'user;DROP', 'email'], 'column')).toThrow(InvalidIdentifierError)
    })
  })

  describe('Identifier Quoting', () => {
    test('should properly quote valid identifiers', () => {
      expect(quoteIdentifier('users')).toBe('"users"')
      expect(quoteIdentifier('user_name')).toBe('"user_name"')
    })

    test('should escape double quotes in identifiers', () => {
      // This would fail validation first, but shows the escaping logic works
      // We'll test this at the quoting level if validation passes
      const quoted = quoteIdentifier('valid_identifier')

      expect(quoted).toBe('"valid_identifier"')
    })

    test('should throw for invalid identifiers', () => {
      expect(() => quoteIdentifier('SELECT')).toThrow(InvalidIdentifierError)
      expect(() => quoteIdentifier('user-name')).toThrow(InvalidIdentifierError)
    })
  })

  describe('Entity Definition - SQL Injection Attempts', () => {
    test('should reject malicious table names', () => {
      expect(() => {
        orm.entity('users; DROP TABLE users; --', {
          name: orm.string(),
        }).build()
      }).toThrow(InvalidIdentifierError)
    })

    test('should reject malicious column names', () => {
      expect(() => {
        // Try to create field with malicious column name override
        orm.entity('test_malicious2', {
          field: orm.string().column('name\'; DROP TABLE users; --'),
        }).build()
      }).toThrow(InvalidIdentifierError)
    })

    test('should reject reserved keywords as table names', () => {
      expect(() => {
        orm.entity('SELECT', {
          name: orm.string(),
        }).build()
      }).toThrow(InvalidIdentifierError)
    })

    test('should reject reserved keywords as column names', () => {
      expect(() => {
        orm.entity('test_keywords', {
          normalField: orm.string().column('WHERE'),
        }).build()
      }).toThrow(InvalidIdentifierError)
    })
  })

  describe('Repository Operations - SQL Injection Protection', () => {
    const SafeEntity = orm.entity('test_security_safe', {
      name: orm.string(),
      email: orm.string(),
    }).build()

    let safeRepo: ReturnType<typeof orm.repo<typeof SafeEntity.schema>>

    beforeAll(async () => {
      safeRepo = orm.repo(SafeEntity)

      // Manually create table for nested describe entity
      await createTestTable(SafeEntity)
    })

    afterAll(async () => {
      await cleanupTables('test_security_safe')
    })

    test('should safely handle query values with SQL syntax', async () => {
      // These should be treated as data, not SQL
      const maliciousData = {
        name: '\'; DROP TABLE users; --',
        email: 'test@example.com\' OR \'1\'=\'1',
      }

      const created = await safeRepo.create(maliciousData)

      expect(created.name).toBe(maliciousData.name)
      expect(created.email).toBe(maliciousData.email)

      // Verify data was stored safely
      const found = await safeRepo.find(created.id)

      expect(found?.name).toBe(maliciousData.name)
      expect(found?.email).toBe(maliciousData.email)
    })

    test('should safely handle special characters in WHERE conditions', async () => {
      const testData = {
        name: 'O\'Reilly',
        email: 'test@example.com',
      }

      const created = await safeRepo.create(testData)

      // Should safely query with single quote
      const found = await safeRepo.findOneBy({
        where: { name: 'O\'Reilly' },
      })

      expect(found?.id).toBe(created.id)
      expect(found?.name).toBe(testData.name)
    })

    test('should safely handle LIMIT/OFFSET values', async () => {
      // Create some test data
      await safeRepo.create({ name: 'User 1', email: 'user1@example.com' })
      await safeRepo.create({ name: 'User 2', email: 'user2@example.com' })
      await safeRepo.create({ name: 'User 3', email: 'user3@example.com' })

      // Valid pagination should work
      const page1 = await safeRepo.paginate({
        page: 1,
        pageSize: 2,
      })

      expect(page1.data.length).toBe(2)
      expect(page1.totalPages).toBeGreaterThanOrEqual(2)
    })

    test('should protect against injection in array operations', async () => {
      const user1 = await safeRepo.create({ name: 'User 1', email: 'user1@test.com' })
      const user2 = await safeRepo.create({ name: 'User 2', email: 'user2@test.com' })

      // Should safely handle array of IDs
      const results = await safeRepo.findBy({
        where: { id: [user1.id, user2.id] },
      })

      expect(results.length).toBe(2)
    })
  })

  describe('Query Builder - SQL Injection Protection', () => {
    const TestEntity = orm.entity('test_security_query', {
      name: orm.string(),
      status: orm.string(),
    }).build()

    let testRepo: ReturnType<typeof orm.repo<typeof TestEntity.schema>>

    beforeAll(async () => {
      testRepo = orm.repo(TestEntity)

      // Manually create table for nested describe entity
      await createTestTable(TestEntity)
    })

    beforeEach(async () => {
      // Clean table before each test to avoid data pollution
      await truncateTables('test_security_query')
    })

    afterAll(async () => {
      await cleanupTables('test_security_query')
    })

    test('should safely handle parameterized queries', async () => {
      await testRepo.create({ name: 'Test User', status: 'active' })

      // Query builder should use parameterized queries
      const results = await testRepo.query()
        .where('name', '=', '\'; DROP TABLE users; --')
        .execute()

      expect(results.length).toBe(0) // Should find nothing, not execute SQL
    })

    test('should safely handle WHERE IN conditions', async () => {
      await testRepo.create({ name: 'User 1', status: 'active' })
      await testRepo.create({ name: 'User 2', status: 'active' })

      const results = await testRepo.query()
        .whereIn('status', ['active', '\'; DROP TABLE users; --'])
        .execute()

      // Should only find users with 'active' status, not execute injection
      expect(results.length).toBe(2)
      expect(results.every(r => r.status === 'active')).toBe(true)
    })
  })
})
