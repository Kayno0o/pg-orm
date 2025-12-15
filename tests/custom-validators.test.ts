import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ValidationError } from '../src/validation'
import { createTestTable, getTestSchema, orm, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Custom Field Validators', () => {
  const schema = getTestSchema()

  beforeAll(async () => {
    await setupTestDatabase({ schema })
  })

  afterAll(async () => {
    await teardownTestDatabase({ schema })
  })

  describe('.refine() method', () => {
    test('should validate custom string validator', async () => {
      const User = orm.entity('custom_val_string', f => ({
        name: f.string().refine(
          val => val.length >= 3,
          'Name must be at least 3 characters',
        ),
        email: f.string(),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      expect(async () => {
        await users.create({ name: 'Al', email: 'alice@test.com' })
      }).toThrow(ValidationError)

      const user = await users.create({ name: 'Alice', email: 'alice@test.com' })

      expect(user.name).toBe('Alice')
    })

    test('should validate custom number validator', async () => {
      const User = orm.entity('custom_val_number', f => ({
        name: f.string(),
        age: f.number().refine(
          val => val >= 18,
          'Age must be at least 18',
        ),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      expect(async () => {
        await users.create({ name: 'Bob', age: 16 })
      }).toThrow(ValidationError)

      const user = await users.create({ name: 'Bob', age: 25 })

      expect(user.age).toBe(25)
    })

    test('should support async validators', async () => {
      const User = orm.entity('custom_val_async', f => ({
        email: f.string().refine(
          async (val) => {
            await new Promise(resolve => setTimeout(resolve, 10))

            return val.includes('@')
          },
          'Email must contain @',
        ),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      expect(async () => {
        await users.create({ email: 'invalid' })
      }).toThrow(ValidationError)

      const user = await users.create({ email: 'valid@test.com' })

      expect(user.email).toBe('valid@test.com')
    })

    test('should support multiple validators per field', async () => {
      const User = orm.entity('custom_val_multiple', f => ({
        password: f
          .string()
          .refine(val => val.length >= 8, 'Password must be at least 8 characters')
          .refine(val => (/[A-Z]/).test(val), 'Password must contain uppercase letter')
          .refine(val => (/\d/).test(val), 'Password must contain number'),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      expect(async () => {
        await users.create({ password: 'short' })
      }).toThrow(ValidationError)

      expect(async () => {
        await users.create({ password: 'nouppercase1' })
      }).toThrow(ValidationError)

      expect(async () => {
        await users.create({ password: 'NoNumber' })
      }).toThrow(ValidationError)

      const user = await users.create({ password: 'ValidPass1' })

      expect(user.password).toBe('ValidPass1')
    })

    test('should support custom error messages from validator', async () => {
      const User = orm.entity('custom_val_messages', f => ({
        code: f.string().refine(
          (val) => {
            if (val.length !== 6)
              return 'Code must be exactly 6 characters'

            if (!(/^\d+$/).test(val))
              return 'Code must contain only digits'

            return true
          },
          'Code validation failed',
        ),
      })).build()

      await createTestTable(User)

      const users = orm.repo(User)

      expect(async () => {
        await users.create({ code: '12345' })
      }).toThrow(ValidationError)

      expect(async () => {
        await users.create({ code: '12345a' })
      }).toThrow(ValidationError)

      const user = await users.create({ code: '123456' })

      expect(user.code).toBe('123456')
    })
  })
})
