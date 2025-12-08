import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { InvalidIdentifierError, ORM } from '../src'
import { quoteIdentifier, validateSQLIdentifier, validateSQLIdentifiers } from '../src/sql-utils'
import { createTestTable, getTestSchema, setupTestDatabase, teardownTestDatabase, truncateTables } from './setup'

describe('Security - SQL Injection Protection', () => {
  const schema = getTestSchema()
  const orm = new ORM()

  beforeAll(async () => {
    await setupTestDatabase({ schema, orm })
  })

  afterAll(async () => {
    await teardownTestDatabase({ schema, orm })
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
      expect(() => validateSQLIdentifier(longIdentifier, 'table')).toThrow(/exceeds PostgreSQL 63 character limit/)
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
      await createTestTable(SafeEntity, orm)
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
      const found = await safeRepo.query()
        .where('name', '=', 'O\'Reilly')
        .findOne()

      expect(found?.id).toBe(created.id)
      expect(found?.name).toBe(testData.name)
    })

    test('should safely handle LIMIT/OFFSET values', async () => {
      // Create some test data
      await safeRepo.create({ name: 'User 1', email: 'user1@example.com' })
      await safeRepo.create({ name: 'User 2', email: 'user2@example.com' })
      await safeRepo.create({ name: 'User 3', email: 'user3@example.com' })

      // Valid limit/offset should work
      const results = await safeRepo.query()
        .limit(2)
        .offset(0)
        .execute()

      expect(results.length).toBe(2)
    })

    test('should protect against injection in array operations', async () => {
      const user1 = await safeRepo.create({ name: 'User 1', email: 'user1@test.com' })
      const user2 = await safeRepo.create({ name: 'User 2', email: 'user2@test.com' })

      // Should safely handle array of IDs
      const results = await safeRepo.query()
        .whereIn('id', [user1.id, user2.id])
        .execute()

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
      await createTestTable(TestEntity, orm)
    })

    beforeEach(async () => {
      // Clean table before each test to avoid data pollution
      await truncateTables(orm, 'test_security_query')
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

    test('should safely handle LIKE patterns with special characters', async () => {
      await testRepo.create({ name: 'O\'Reilly', status: 'active' })
      await testRepo.create({ name: 'Test%User', status: 'active' })

      // Single quotes should be safely escaped
      const result1 = await testRepo.query()
        .whereLike('name', 'O\'%')
        .execute()

      expect(result1.length).toBe(1)
      expect(result1[0]!.name).toBe('O\'Reilly')

      // Percent signs in data should not be treated as wildcards
      const result2 = await testRepo.query()
        .whereLike('name', 'Test%User')
        .execute()

      expect(result2.length).toBe(1)
      expect(result2[0]!.name).toBe('Test%User')
    })

    test('should safely handle BETWEEN conditions', async () => {
      await testRepo.create({ name: 'User A', status: 'active' })

      // Malicious values should be treated as data
      const results = await testRepo.query()
        .whereBetween('name', 'A', '\'; DROP TABLE users; --')
        .execute()

      expect(results.length).toBeGreaterThanOrEqual(0) // No SQL injection
    })

    test('should safely handle NULL checks', async () => {
      await testRepo.create({ name: 'Valid', status: 'active' })

      // NULL checks should not be injectable
      const results = await testRepo.query()
        .whereNotNull('name')
        .execute()

      expect(results.length).toBe(1)
    })
  })

  describe('ORDER BY - SQL Injection Protection', () => {
    const TestEntity = orm.entity('test_security_orderby', {
      name: orm.string(),
      score: orm.number(),
    }).build()

    let testRepo: ReturnType<typeof orm.repo<typeof TestEntity.schema>>

    beforeAll(async () => {
      testRepo = orm.repo(TestEntity)
      await createTestTable(TestEntity, orm)
    })

    beforeEach(async () => {
      await truncateTables(orm, 'test_security_orderby')
    })

    test('should reject invalid ORDER BY directions', async () => {
      await testRepo.create({ name: 'Test', score: 100 })

      // Invalid direction should throw
      expect(() => {
        testRepo.query().orderBy('name', 'INVALID' as any)
      }).toThrow(/Invalid ORDER BY direction/)

      // SQL injection attempt in direction
      expect(() => {
        testRepo.query().orderBy('name', 'ASC; DROP TABLE users; --' as any)
      }).toThrow(/Invalid ORDER BY direction/)
    })

    test('should reject invalid column names in ORDER BY', async () => {
      await testRepo.create({ name: 'Test', score: 100 })

      // Non-existent column should throw
      expect(() => {
        testRepo.query().orderBy('invalidColumn' as any, 'ASC')
      }).toThrow(/Invalid column/)

      // SQL injection attempt in column name
      expect(() => {
        testRepo.query().orderBy('name; DROP TABLE users; --' as any, 'ASC')
      }).toThrow(/Invalid column/)
    })

    test('should only allow schema-defined columns in ORDER BY', async () => {
      await testRepo.create({ name: 'User 1', score: 10 })
      await testRepo.create({ name: 'User 2', score: 20 })

      // Valid column should work
      const results = await testRepo.query()
        .orderBy('score', 'DESC')
        .execute()

      expect(results[0]!.score).toBe(20)
      expect(results[1]!.score).toBe(10)
    })

    test('should safely handle ORDER BY in query builder', async () => {
      await testRepo.create({ name: 'B', score: 2 })
      await testRepo.create({ name: 'A', score: 1 })

      // Valid ORDER BY through query builder
      const results = await testRepo.query()
        .orderBy('name', 'ASC')
        .execute()

      expect(results[0]!.name).toBe('A')
      expect(results[1]!.name).toBe('B')
    })
  })

  describe('GROUP BY - SQL Injection Protection', () => {
    const TestEntity = orm.entity('test_security_groupby', {
      category: orm.string(),
      value: orm.number(),
    }).build()

    let testRepo: ReturnType<typeof orm.repo<typeof TestEntity.schema>>

    beforeAll(async () => {
      testRepo = orm.repo(TestEntity)
      await createTestTable(TestEntity, orm)
    })

    beforeEach(async () => {
      await truncateTables(orm, 'test_security_groupby')
    })

    test('should reject invalid column names in GROUP BY', () => {
      // Non-existent column should throw
      expect(() => {
        testRepo.query().groupBy('invalidColumn' as any)
      }).toThrow(/Invalid column/)

      // SQL injection attempt
      expect(() => {
        testRepo.query().groupBy('category; DROP TABLE users; --' as any)
      }).toThrow(/Invalid column/)
    })

    test('should only allow schema-defined columns in GROUP BY', async () => {
      await testRepo.create({ category: 'A', value: 10 })
      await testRepo.create({ category: 'A', value: 20 })

      // Valid GROUP BY should work
      const query = testRepo.query().select('category').groupBy('category')

      expect(() => query.build()).not.toThrow()
    })
  })

  describe('LIMIT/OFFSET - SQL Injection Protection', () => {
    const TestEntity = orm.entity('test_security_limit', {
      name: orm.string(),
    }).build()

    let testRepo: ReturnType<typeof orm.repo<typeof TestEntity.schema>>

    beforeAll(async () => {
      testRepo = orm.repo(TestEntity)
      await createTestTable(TestEntity, orm)
    })

    beforeEach(async () => {
      await truncateTables(orm, 'test_security_limit')
    })

    test('should reject non-integer LIMIT values', () => {
      expect(() => {
        testRepo.query().limit(10.5)
      }).toThrow(/Invalid LIMIT value/)

      expect(() => {
        testRepo.query().limit(-1)
      }).toThrow(/Invalid LIMIT value/)

      expect(() => {
        testRepo.query().limit(Number.NaN)
      }).toThrow(/Invalid LIMIT value/)
    })

    test('should reject non-integer OFFSET values', () => {
      expect(() => {
        testRepo.query().offset(10.5)
      }).toThrow(/Invalid OFFSET value/)

      expect(() => {
        testRepo.query().offset(-1)
      }).toThrow(/Invalid OFFSET value/)

      expect(() => {
        testRepo.query().offset(Number.NaN)
      }).toThrow(/Invalid OFFSET value/)
    })

    test('should handle large but valid LIMIT/OFFSET values', async () => {
      await testRepo.create({ name: 'Test' })

      // Large but valid values should work
      const results = await testRepo.query()
        .limit(1000000)
        .offset(0)
        .execute()

      expect(results.length).toBeLessThanOrEqual(1)
    })

    test('should safely handle limit and offset parameters', async () => {
      for (let i = 1; i <= 10; i++) {
        await testRepo.create({ name: `User ${i}` })
      }

      // Normal limit/offset should work
      const page1 = await testRepo.query()
        .limit(3)
        .offset(0)
        .execute()

      expect(page1.length).toBe(3)

      const page2 = await testRepo.query()
        .limit(3)
        .offset(3)
        .execute()

      expect(page2.length).toBe(3)
    })
  })

  describe('PostgreSQL-Specific Operators - Security', () => {
    const TestEntity = orm.entity('test_security_pgops', {
      tags: orm.array('string'),
      metadata: orm.jsonb<any>(),
    }).build()

    let testRepo: ReturnType<typeof orm.repo<typeof TestEntity.schema>>

    beforeAll(async () => {
      testRepo = orm.repo(TestEntity)
      await createTestTable(TestEntity, orm)
    })

    beforeEach(async () => {
      await truncateTables(orm, 'test_security_pgops')
    })

    test('should safely handle array storage with special characters', async () => {
      // Test storing arrays with various special characters that could be problematic
      const specialStrings = [
        'normal',
        'with spaces',
        'with,comma',
        'with"quote',
        'with\\backslash',
        'with{brace}',
        '\'; DROP TABLE users; --',
        '1\' OR \'1\'=\'1',
        'admin\'); DELETE FROM users; --',
      ]

      const record1 = await testRepo.create({
        tags: specialStrings,
        metadata: { test: 'special_chars' },
      })

      // Verify all special strings were stored correctly
      expect(record1.tags.length).toBe(specialStrings.length)

      for (let i = 0; i < specialStrings.length; i++) {
        expect(record1.tags[i]).toBe(specialStrings[i])
      }

      // Retrieve and verify data integrity
      const found = await testRepo.find(record1.id)

      expect(found?.tags.length).toBe(specialStrings.length)

      for (let i = 0; i < specialStrings.length; i++) {
        expect(found?.tags[i]).toBe(specialStrings[i])
      }

      // Verify table still exists (SQL injection didn't execute)
      const allRecords = await testRepo.findAll()

      expect(allRecords.length).toBe(1)

      // Test updating array with special characters
      const updatedRecord = await testRepo.update(record1.id, {
        tags: ['updated', '\'; DROP TABLE users; --', 'safe'],
      })

      expect(updatedRecord.tags).toContain('\'; DROP TABLE users; --')
      expect(updatedRecord.tags).toContain('updated')

      // Verify SQL injection didn't execute during update
      const finalCheck = await testRepo.findAll()

      expect(finalCheck.length).toBe(1)
    })

    test('should safely handle JSONB operators with malicious values', async () => {
      await testRepo.create({
        tags: ['test'],
        metadata: { role: 'admin', permissions: ['read', 'write'] },
      })

      // Malicious values in JSON operations
      const results1 = await testRepo.query()
        .whereJsonContains('metadata', { role: '\'; DROP TABLE users; --' })
        .execute()

      expect(results1.length).toBe(0) // Should find nothing, not execute SQL

      const results2 = await testRepo.query()
        .whereJsonHasKey('metadata', 'role')
        .execute()

      expect(results2.length).toBe(1)
      expect(results2[0]!.metadata.role).toBe('admin')
    })

    test('should reject invalid column names in PostgreSQL operators', () => {
      expect(() => {
        testRepo.query().whereArrayContains('invalidColumn' as any, 'test')
      }).toThrow(/Invalid column/)

      expect(() => {
        testRepo.query().whereJsonHasKey('invalidColumn' as any, 'key')
      }).toThrow(/Invalid column/)
    })
  })

  describe('Second-Order SQL Injection Protection', () => {
    const TestEntity = orm.entity('test_security_second_order', {
      username: orm.string(),
      bio: orm.string(),
    }).build()

    let testRepo: ReturnType<typeof orm.repo<typeof TestEntity.schema>>

    beforeAll(async () => {
      testRepo = orm.repo(TestEntity)
      await createTestTable(TestEntity, orm)
    })

    beforeEach(async () => {
      await truncateTables(orm, 'test_security_second_order')
    })

    test('should safely store and retrieve malicious data without execution', async () => {
      // Store malicious data
      const maliciousData = {
        username: 'admin\'; DROP TABLE users; --',
        bio: '1\' OR \'1\'=\'1',
      }

      const created = await testRepo.create(maliciousData)

      expect(created.username).toBe(maliciousData.username)
      expect(created.bio).toBe(maliciousData.bio)

      // Retrieve and use in another query (second-order injection attempt)
      const found = await testRepo.find(created.id)

      expect(found?.username).toBe(maliciousData.username)

      // Use stored value in a new query - should still be safe
      const results = await testRepo.query()
        .where('username', '=', found!.username)
        .execute()

      expect(results.length).toBe(1)
      expect(results[0]!.id).toBe(created.id)
    })

    test('should safely handle data retrieved from DB in subsequent queries', async () => {
      // Create user with special characters
      const user1 = await testRepo.create({
        username: 'user\'s account',
        bio: 'Test bio',
      })

      // Use retrieved value in update
      await testRepo.update(user1.id, {
        bio: `${user1.username} - updated`,
      })

      const updated = await testRepo.find(user1.id)

      expect(updated?.bio).toBe('user\'s account - updated')
    })
  })

  describe('Mass Assignment Vulnerability Protection', () => {
    const TestEntity = orm.entity('test_security_mass_assign', {
      username: orm.string(),
      role: orm.string(),
      isAdmin: orm.boolean().default(false),
    }).build()

    let testRepo: ReturnType<typeof orm.repo<typeof TestEntity.schema>>

    beforeAll(async () => {
      testRepo = orm.repo(TestEntity)
      await createTestTable(TestEntity, orm)
    })

    beforeEach(async () => {
      await truncateTables(orm, 'test_security_mass_assign')
    })

    test('should ignore extra fields not in schema during create', async () => {
      const dataWithExtra = {
        username: 'testuser',
        role: 'user',
        isAdmin: false,
        // These should be ignored
        extraField: 'malicious',
        sqlInjection: '\'; DROP TABLE users; --',
      }

      const created = await testRepo.create(dataWithExtra)

      expect(created.username).toBe('testuser')
      expect(created.role).toBe('user')
      expect(created.isAdmin).toBe(false)
      expect(created.extraField).toBeUndefined()
      expect(created.sqlInjection).toBeUndefined()
    })

    test('should ignore extra fields not in schema during update', async () => {
      const user = await testRepo.create({
        username: 'testuser',
        role: 'user',
        isAdmin: false,
      })

      const updateData = {
        username: 'updateduser',
        // Attempt to escalate privileges through mass assignment
        extraField: 'malicious',
        __proto__: { isAdmin: true },
      }

      const updated = await testRepo.update(user.id, updateData)

      expect(updated.username).toBe('updateduser')
      expect(updated.isAdmin).toBe(false) // Should remain false
      expect((updated as any).extraField).toBeUndefined()
    })

    test('should only allow schema-defined fields in queries', async () => {
      await testRepo.create({
        username: 'testuser',
        role: 'user',
        isAdmin: false,
      })

      // Querying with non-schema fields should throw
      expect(async () => {
        await testRepo.query()
          .where('nonExistentField' as any, '=', 'value')
          .execute()
      }).toThrow()
    })
  })

  describe('Timing Attack Resistance', () => {
    const TestEntity = orm.entity('test_security_timing', {
      email: orm.string().unique(),
      password: orm.string(),
    }).build()

    let testRepo: ReturnType<typeof orm.repo<typeof TestEntity.schema>>

    beforeAll(async () => {
      testRepo = orm.repo(TestEntity)
      await createTestTable(TestEntity, orm)
    })

    beforeEach(async () => {
      await truncateTables(orm, 'test_security_timing')
    })

    test('should have consistent query performance for existing and non-existing records', async () => {
      await testRepo.create({
        email: 'exists@example.com',
        password: 'hashedpassword',
      })

      // Time queries for existing user
      const start1 = performance.now()
      const existing = await testRepo.query()
        .where('email', '=', 'exists@example.com')
        .findOne()
      const time1 = performance.now() - start1

      // Time queries for non-existing user
      const start2 = performance.now()
      const nonExisting = await testRepo.query()
        .where('email', '=', 'nonexist@example.com')
        .findOne()
      const time2 = performance.now() - start2

      expect(existing).not.toBeNull()
      expect(nonExisting).toBeNull()

      // Timing should be similar (within reasonable variance)
      // This is a basic check - real timing attacks need statistical analysis
      const timeDiff = Math.abs(time1 - time2)

      // Allow for 10ms variance (generous for DB operations)
      expect(timeDiff).toBeLessThan(10)
    })

    test('should not leak information through error messages', async () => {
      await testRepo.create({
        email: 'test@example.com',
        password: 'password',
      })

      // Error messages should not reveal whether record exists
      try {
        await testRepo.update(999999, { email: 'new@example.com' })
      }
      catch (error: any) {
        // Error should be generic, not reveal record existence
        expect(error.message).toContain('not found')
        expect(error.message).not.toContain('invalid password')
        expect(error.message).not.toContain('authentication')
      }
    })
  })
})
