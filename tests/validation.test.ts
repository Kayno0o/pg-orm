import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import { ValidationError } from '../src/validation'
import { cleanupTables, createTestTable, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Data Validation', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  describe('Required Fields', () => {
    test('should validate required string field', async () => {
      const User = orm.entity('test_validation_required', {
        name: orm.string(),
        email: orm.string(),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)

      await expect(async () => {
        await users.create({ name: 'Test' } as any)
      }).toThrow()

      await cleanupTables('test_validation_required')
    })

    test('should allow nullable fields to be omitted', async () => {
      const User = orm.entity('test_validation_nullable', {
        name: orm.string(),
        email: orm.string(),
        age: orm.number().nullable(),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({
        name: 'Test',
        email: 'test@example.com',
      })

      expect(user.age).toBeNull()

      await cleanupTables('test_validation_nullable')
    })

    test('should allow fields with defaults to be omitted', async () => {
      const User = orm.entity('test_validation_default', {
        name: orm.string(),
        email: orm.string(),
        isActive: orm.boolean().default(true),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({
        name: 'Test',
        email: 'test@example.com',
      })

      expect(user.isActive).toBe(true)

      await cleanupTables('test_validation_default')
    })
  })

  describe('String Field Validation', () => {
    test('should validate maxLength constraint', async () => {
      const User = orm.entity('test_validation_maxlength', {
        name: orm.string().maxLength(10),
        email: orm.string(),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)

      await expect(async () => {
        await users.create({
          name: 'This name is way too long',
          email: 'test@example.com',
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_maxlength')
    })

    test('should validate minLength constraint', async () => {
      const User = orm.entity('test_validation_minlength', {
        name: orm.string().minLength(5),
        email: orm.string(),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)

      await expect(async () => {
        await users.create({
          name: 'Joe',
          email: 'test@example.com',
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_minlength')
    })

    test('should accept string within length constraints', async () => {
      const User = orm.entity('test_validation_string_ok', {
        name: orm.string().minLength(3).maxLength(20),
        email: orm.string(),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({
        name: 'John Doe',
        email: 'test@example.com',
      })

      expect(user.name).toBe('John Doe')

      await cleanupTables('test_validation_string_ok')
    })
  })

  describe('Number Field Validation', () => {
    test('should validate min constraint', async () => {
      const Product = orm.entity('test_validation_min', {
        name: orm.string(),
        price: orm.number().min(0),
      }).build()

      await createTestTable(Product)

      const products = orm.repo(Product)

      await expect(async () => {
        await products.create({
          name: 'Product',
          price: -10,
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_min')
    })

    test('should validate max constraint', async () => {
      const Product = orm.entity('test_validation_max', {
        name: orm.string(),
        rating: orm.number().max(5),
      }).build()

      await createTestTable(Product)

      const products = orm.repo(Product)

      await expect(async () => {
        await products.create({
          name: 'Product',
          rating: 10,
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_max')
    })

    test('should validate integer constraint', async () => {
      const Product = orm.entity('test_validation_integer', {
        name: orm.string(),
        quantity: orm.number().integer(),
      }).build()

      await createTestTable(Product)

      const products = orm.repo(Product)

      await expect(async () => {
        await products.create({
          name: 'Product',
          quantity: 3.14,
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_integer')
    })

    test('should accept number within constraints', async () => {
      const Product = orm.entity('test_validation_number_ok', {
        name: orm.string(),
        price: orm.number().min(0).max(1000),
      }).build()

      await createTestTable(Product)

      const products = orm.repo(Product)
      const product = await products.create({
        name: 'Product',
        price: 99.99,
      })

      expect(product.price).toBe(99.99)

      await cleanupTables('test_validation_number_ok')
    })
  })

  describe('Enum Field Validation', () => {
    test('should validate enum values', async () => {
      const User = orm.entity('test_validation_enum', {
        name: orm.string(),
        email: orm.string(),
        role: orm.enum(['admin', 'user', 'moderator'] as const),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)

      await expect(async () => {
        await users.create({
          name: 'Test',
          email: 'test@example.com',
          role: 'invalid' as any,
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_enum')
    })

    test('should accept valid enum values', async () => {
      const User = orm.entity('test_validation_enum_ok', {
        name: orm.string(),
        email: orm.string(),
        role: orm.enum(['admin', 'user', 'moderator'] as const),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({
        name: 'Test',
        email: 'test@example.com',
        role: 'admin',
      })

      expect(user.role).toBe('admin')

      await cleanupTables('test_validation_enum_ok')
    })
  })

  describe('Type Validation', () => {
    test('should validate string type', async () => {
      const User = orm.entity('test_validation_string_type', {
        name: orm.string(),
        email: orm.string(),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)

      await expect(async () => {
        await users.create({
          name: 123 as any,
          email: 'test@example.com',
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_string_type')
    })

    test('should validate number type', async () => {
      const Product = orm.entity('test_validation_number_type', {
        name: orm.string(),
        price: orm.number(),
      }).build()

      await createTestTable(Product)

      const products = orm.repo(Product)

      await expect(async () => {
        await products.create({
          name: 'Product',
          price: 'not a number' as any,
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_number_type')
    })

    test('should validate boolean type', async () => {
      const User = orm.entity('test_validation_boolean_type', {
        name: orm.string(),
        email: orm.string(),
        isActive: orm.boolean(),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)

      await expect(async () => {
        await users.create({
          name: 'Test',
          email: 'test@example.com',
          isActive: 'yes' as any,
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_boolean_type')
    })

    test('should validate array type', async () => {
      const User = orm.entity('test_validation_array_type', {
        name: orm.string(),
        email: orm.string(),
        tags: orm.array('string'),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)

      await expect(async () => {
        await users.create({
          name: 'Test',
          email: 'test@example.com',
          tags: 'not an array' as any,
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_array_type')
    })
  })

  describe('Update Validation', () => {
    test('should validate update data', async () => {
      const User = orm.entity('test_validation_update', {
        name: orm.string().maxLength(10),
        email: orm.string(),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({
        name: 'Short',
        email: 'test@example.com',
      })

      await expect(async () => {
        await users.update(user.id, {
          name: 'This is way too long for validation',
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_update')
    })

    test('should allow partial updates without validation errors', async () => {
      const User = orm.entity('test_validation_partial_update', {
        name: orm.string(),
        email: orm.string(),
        age: orm.number().min(0).nullable(),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({
        name: 'Test',
        email: 'test@example.com',
      })

      // Should allow updating just one field
      const updated = await users.update(user.id, {
        age: 25,
      })

      expect(updated.age).toBe(25)
      expect(updated.name).toBe('Test')

      await cleanupTables('test_validation_partial_update')
    })
  })

  describe('Validation Error Details', () => {
    test('should provide detailed error information', async () => {
      const User = orm.entity('test_validation_error_details', {
        name: orm.string().minLength(5),
        email: orm.string(),
      }).build()

      await createTestTable(User)

      const users = orm.repo(User)

      try {
        await users.create({
          name: 'Joe',
          email: 'test@example.com',
        })
        expect(true).toBe(false) // Should not reach here
      }
      catch (error) {
        expect(error).toBeInstanceOf(ValidationError)
        const validationError = error as ValidationError

        expect(validationError.message).toContain('Validation failed')
        expect(validationError.errors).toBeDefined()
        expect(validationError.errors.length).toBeGreaterThan(0)
      }

      await cleanupTables('test_validation_error_details')
    })
  })

  describe('Complex Validation Scenarios', () => {
    test('should validate multiple constraints together', async () => {
      const Product = orm.entity('test_validation_complex', {
        name: orm.string().minLength(3).maxLength(50),
        price: orm.number().min(0).max(10000),
        quantity: orm.number().integer().min(0),
        category: orm.enum(['electronics', 'clothing', 'food'] as const),
        tags: orm.array('string'),
      }).build()

      await createTestTable(Product)

      const products = orm.repo(Product)

      // Valid product
      const valid = await products.create({
        name: 'Valid Product',
        price: 99.99,
        quantity: 100,
        category: 'electronics',
        tags: ['new', 'sale'],
      })

      expect(valid.name).toBe('Valid Product')

      // Invalid - multiple constraint violations
      await expect(async () => {
        await products.create({
          name: 'X', // Too short
          price: -10, // Below min
          quantity: 5.5, // Not integer
          category: 'invalid' as any, // Invalid enum
          tags: ['valid'],
        })
      }).toThrow(ValidationError)

      await cleanupTables('test_validation_complex')
    })
  })
})
