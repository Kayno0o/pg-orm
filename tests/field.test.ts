import { describe, expect, test } from 'bun:test'
import { field as f } from '../src'
import { orm } from './setup'

describe('Field Builders', () => {
  describe('String Field', () => {
    test('should create basic string field', () => {
      const field = f.string()
      const config = field.toConfig()

      expect(config.type).toBe('string')
      expect(config.nullable).toBe(false)
      expect(config.unique).toBe(false)
    })

    test('should set maxLength', () => {
      const field = f.string().maxLength(255)
      const config = field.toConfig()

      expect(config.maxLength).toBe(255)
    })

    test('should set minLength', () => {
      const field = f.string().minLength(3)
      const config = field.toConfig()

      expect(config.minLength).toBe(3)
    })

    test('should set nullable', () => {
      const field = f.string().nullable()
      const config = field.toConfig()

      expect(config.nullable).toBe(true)
    })

    test('should set unique', () => {
      const field = f.string().unique()
      const config = field.toConfig()

      expect(config.unique).toBe(true)
    })

    test('should set default value', () => {
      const field = f.string().default('hello')
      const config = field.toConfig()

      expect(config.default).toBe('hello')
    })

    test('should set custom column name', () => {
      const field = f.string().column('custom_name')
      const config = field.toConfig()

      expect(config.columnName).toBe('custom_name')
    })

    test('should chain multiple modifiers', () => {
      const field = f.string().maxLength(100).minLength(5).unique().nullable()
      const config = field.toConfig()

      expect(config.maxLength).toBe(100)
      expect(config.minLength).toBe(5)
      expect(config.unique).toBe(true)
      expect(config.nullable).toBe(true)
    })
  })

  describe('Number Field', () => {
    test('should create basic number field', () => {
      const field = f.number()
      const config = field.toConfig()

      expect(config.type).toBe('number')
      expect(config.nullable).toBe(false)
    })

    test('should set min value', () => {
      const field = f.number().min(0)
      const config = field.toConfig()

      expect(config.min).toBe(0)
    })

    test('should set max value', () => {
      const field = f.number().max(100)
      const config = field.toConfig()

      expect(config.max).toBe(100)
    })

    test('should set integer flag', () => {
      const field = f.number().integer()
      const config = field.toConfig()

      expect(config.integer).toBe(true)
    })

    test('should set default value', () => {
      const field = f.number().default(42)
      const config = field.toConfig()

      expect(config.default).toBe(42)
    })

    test('should chain multiple modifiers', () => {
      const field = f.number().integer().min(0).max(100).default(0)
      const config = field.toConfig()

      expect(config.integer).toBe(true)
      expect(config.min).toBe(0)
      expect(config.max).toBe(100)
      expect(config.default).toBe(0)
    })
  })

  describe('Boolean Field', () => {
    test('should create basic boolean field', () => {
      const field = f.boolean()
      const config = field.toConfig()

      expect(config.type).toBe('boolean')
      expect(config.nullable).toBe(false)
    })

    test('should set nullable', () => {
      const field = f.boolean().nullable()
      const config = field.toConfig()

      expect(config.nullable).toBe(true)
    })

    test('should set default value', () => {
      const field = f.boolean().default(true)
      const config = field.toConfig()

      expect(config.default).toBe(true)
    })
  })

  describe('UUID Field', () => {
    test('should create basic uuid field', () => {
      const field = f.uuid()
      const config = field.toConfig()

      expect(config.type).toBe('uuid')
      expect(config.nullable).toBe(false)
    })

    test('should set autoGenerate', () => {
      const field = f.uuid().autoGenerate()
      const config = field.toConfig()

      expect(config.autoGenerate).toBe(true)
    })

    test('should set unique', () => {
      const field = f.uuid().unique()
      const config = field.toConfig()

      expect(config.unique).toBe(true)
    })
  })

  describe('Timestamp Field', () => {
    test('should create basic timestamp field', () => {
      const field = f.timestamp()
      const config = field.toConfig()

      expect(config.type).toBe('timestamp')
      expect(config.nullable).toBe(false)
    })

    test('should set default value', () => {
      const field = f.timestamp().default('NOW()')
      const config = field.toConfig()

      expect(config.default).toBe('NOW()')
    })
  })

  describe('Date Field', () => {
    test('should create basic date field', () => {
      const field = f.date()
      const config = field.toConfig()

      expect(config.type).toBe('date')
      expect(config.nullable).toBe(false)
    })

    test('should set nullable', () => {
      const field = f.date().nullable()
      const config = field.toConfig()

      expect(config.nullable).toBe(true)
    })
  })

  describe('JSON/JSONB Fields', () => {
    test('should create json field', () => {
      const field = f.json()
      const config = field.toConfig()

      expect(config.type).toBe('json')
      expect(config.nullable).toBe(false)
    })

    test('should create jsonb field', () => {
      const field = f.jsonb()
      const config = field.toConfig()

      expect(config.type).toBe('jsonb')
      expect(config.nullable).toBe(false)
    })

    test('should set nullable on jsonb', () => {
      const field = f.jsonb().nullable()
      const config = field.toConfig()

      expect(config.nullable).toBe(true)
    })
  })

  describe('Array Fields', () => {
    test('should create string array field', () => {
      const field = f.array('string')
      const config = field.toConfig()

      expect(config.type).toBe('array')
      expect(config.arrayType).toBe('string')
      expect(config.nullable).toBe(false)
    })

    test('should create number array field', () => {
      const field = f.array('number')
      const config = field.toConfig()

      expect(config.type).toBe('array')
      expect(config.arrayType).toBe('number')
    })

    test('should create boolean array field', () => {
      const field = f.array('boolean')
      const config = field.toConfig()

      expect(config.type).toBe('array')
      expect(config.arrayType).toBe('boolean')
    })

    test('should set nullable on array', () => {
      const field = f.array('string').nullable()
      const config = field.toConfig()

      expect(config.nullable).toBe(true)
    })

    test('should set default value on array', () => {
      const field = f.array('string').default([])
      const config = field.toConfig()

      expect(config.default).toEqual([])
    })
  })

  describe('Enum Fields', () => {
    test('should create enum field', () => {
      const field = f.enum(['admin', 'user', 'moderator'] as const)
      const config = field.toConfig()

      expect(config.type).toBe('enum')
      expect(config.values).toEqual(['admin', 'user', 'moderator'])
    })

    test('should set nullable on enum', () => {
      const field = f.enum(['active', 'inactive'] as const).nullable()
      const config = field.toConfig()

      expect(config.nullable).toBe(true)
    })

    test('should set default value on enum', () => {
      const field = f.enum(['pending', 'approved', 'rejected'] as const).default('pending')
      const config = field.toConfig()

      expect(config.default).toBe('pending')
    })
  })

  describe('Blob Field', () => {
    test('should create basic blob field', () => {
      const field = f.blob()
      const config = field.toConfig()

      expect(config.type).toBe('blob')
      expect(config.nullable).toBe(false)
    })

    test('should set nullable on blob', () => {
      const field = f.blob().nullable()
      const config = field.toConfig()

      expect(config.nullable).toBe(true)
    })
  })

  describe('Field Builder Behavior', () => {
    test('field builders mutate and return same instance for performance', () => {
      const builder = f.string()
      const modified = builder.maxLength(100).nullable()

      // Builder pattern mutates for performance - same instance returned
      expect(builder as any).toBe(modified)

      const config = builder.toConfig()

      expect(config.maxLength).toBe(100)
      expect(config.nullable as any).toBe(true)
    })

    test('entity definitions are immutable after build()', () => {
      const User = orm.entity('users', f => ({
        name: f.string(),
      })).build()

      // Entity definition is frozen
      expect(Object.isFrozen(User)).toBe(true)
      expect(() => {
        (User as any).tableName = 'modified'
      }).toThrow()
    })
  })
})
