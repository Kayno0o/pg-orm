/* eslint-disable unused-imports/no-unused-vars */
import type { InferCreateData, InferEntity, InferUpdateData } from '../src'
import { describe, expect, expectTypeOf, test } from 'bun:test'
import { orm } from '../src'

describe('Type System', () => {
  describe('Field Nullable Literal Types', () => {
    test('non-nullable field should have nullable: false as literal type', () => {
      const entity = orm.entity('test', {
        name: orm.string(),
      }).build()

      // The nullable property should be literal false, not boolean
      expectTypeOf<typeof entity.schema.name.nullable>().toEqualTypeOf<false>()
    })

    test('nullable field should have nullable: true as literal type', () => {
      const entity = orm.entity('test', {
        name: orm.string().nullable(),
      }).build()

      // The nullable property should be literal true, not boolean
      expectTypeOf<typeof entity.schema.name.nullable>().toEqualTypeOf<true>()
    })

    test('number field nullable literal type', () => {
      const entity = orm.entity('test', {
        required: orm.number(),
        optional: orm.number().nullable(),
      }).build()

      expectTypeOf<typeof entity.schema.required.nullable>().toEqualTypeOf<false>()
      expectTypeOf<typeof entity.schema.optional.nullable>().toEqualTypeOf<true>()
    })

    test('boolean field nullable literal type', () => {
      const entity = orm.entity('test', {
        required: orm.boolean(),
        optional: orm.boolean().nullable(),
      }).build()

      expectTypeOf<typeof entity.schema.required.nullable>().toEqualTypeOf<false>()
      expectTypeOf<typeof entity.schema.optional.nullable>().toEqualTypeOf<true>()
    })
  })

  describe('Enum Literal Types', () => {
    test('enum should preserve literal tuple type', () => {
      const entity = orm.entity('test', {
        role: orm.enum(['admin', 'user', 'moderator'] as const),
      }).build()

      // Should be the exact literal tuple, not string[]
      expectTypeOf<typeof entity.schema.role.values>().toEqualTypeOf<readonly ['admin', 'user', 'moderator']>()
    })

    test('enum with different values should preserve literal types', () => {
      const entity = orm.entity('test', {
        status: orm.enum(['pending', 'approved', 'rejected'] as const),
      }).build()

      expectTypeOf<typeof entity.schema.status.values>().toEqualTypeOf<readonly ['pending', 'approved', 'rejected']>()
    })

    test('nullable enum should preserve both nullable and values as literals', () => {
      const entity = orm.entity('test', {
        optionalRole: orm.enum(['admin', 'user'] as const).nullable(),
      }).build()

      expectTypeOf<typeof entity.schema.optionalRole.nullable>().toEqualTypeOf<true>()
      expectTypeOf<typeof entity.schema.optionalRole.values>().toEqualTypeOf<readonly ['admin', 'user']>()
    })
  })

  describe('InferEntity Types', () => {
    test('non-nullable fields should be non-nullable in entity', () => {
      const entity = orm.entity('test', {
        name: orm.string(),
        age: orm.number(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      // name and age should be non-nullable (no null or undefined in type)
      expectTypeOf<Entity['name']>().toEqualTypeOf<string>()
      expectTypeOf<Entity['age']>().toEqualTypeOf<number>()
    })

    test('nullable fields should include null (database-aligned)', () => {
      const entity = orm.entity('test', {
        bio: orm.string().nullable(),
        score: orm.number().nullable(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      // nullable fields should include null only (database semantics, not undefined)
      expectTypeOf<Entity['bio']>().toEqualTypeOf<string | null>()
      expectTypeOf<Entity['score']>().toEqualTypeOf<number | null>()
    })

    test('enum fields should use literal union type', () => {
      const entity = orm.entity('test', {
        role: orm.enum(['admin', 'user', 'moderator'] as const),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      // Should be literal union, not string
      expectTypeOf<Entity['role']>().toEqualTypeOf<'admin' | 'user' | 'moderator'>()
    })

    test('nullable enum should be literal union | null', () => {
      const entity = orm.entity('test', {
        role: orm.enum(['admin', 'user'] as const).nullable(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['role']>().toEqualTypeOf<'admin' | 'user' | null>()
    })

    test('mixed nullable and non-nullable fields', () => {
      const entity = orm.entity('test', {
        name: orm.string(),
        email: orm.string(),
        age: orm.number().nullable(),
        bio: orm.string().nullable(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['name']>().toEqualTypeOf<string>()
      expectTypeOf<Entity['email']>().toEqualTypeOf<string>()
      expectTypeOf<Entity['age']>().toEqualTypeOf<number | null>()
      expectTypeOf<Entity['bio']>().toEqualTypeOf<string | null>()
    })
  })

  describe('InferCreateData Types', () => {
    test('non-nullable fields should be required', () => {
      const entity = orm.entity('test', {
        name: orm.string(),
        email: orm.string(),
      }).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // name and email should not be optional
      expectTypeOf<CreateData['name']>().toEqualTypeOf<string>()
      expectTypeOf<CreateData['email']>().toEqualTypeOf<string>()
    })

    test('nullable fields should be optional', () => {
      const entity = orm.entity('test', {
        name: orm.string(),
        bio: orm.string().nullable(),
        age: orm.number().nullable(),
      }).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // name is required (not optional)
      expectTypeOf<CreateData['name']>().toEqualTypeOf<string>()

      // bio and age are optional (can be omitted)
      const validCreate: CreateData = { name: 'John' }

      expect(validCreate).toBeDefined()
    })

    test('fields with defaults should be optional', () => {
      const entity = orm.entity('test', {
        name: orm.string(),
        score: orm.number().default(0),
        isActive: orm.boolean().default(true),
      }).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // name is required (not optional)
      expectTypeOf<CreateData['name']>().toEqualTypeOf<string>()

      // score and isActive are optional
      const validCreate: CreateData = { name: 'John' }

      expect(validCreate).toBeDefined()
    })

    test('enum fields should use literal union type', () => {
      const entity = orm.entity('test', {
        role: orm.enum(['admin', 'user'] as const),
      }).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // Should be literal union, not string
      expectTypeOf<CreateData['role']>().toEqualTypeOf<'admin' | 'user'>()
    })

    test('complex schema with mixed field types', () => {
      const entity = orm.entity('test', {
        name: orm.string(), // required
        email: orm.string().unique(), // required
        age: orm.number().nullable(), // optional (nullable)
        role: orm.enum(['admin', 'user'] as const), // required
        bio: orm.string().nullable(), // optional (nullable)
        score: orm.number().default(0), // optional (has default)
        isActive: orm.boolean().default(true), // optional (has default)
        tags: orm.array('string'), // required
      }).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // Required fields should have specific types
      expectTypeOf<CreateData['name']>().toEqualTypeOf<string>()
      expectTypeOf<CreateData['email']>().toEqualTypeOf<string>()
      expectTypeOf<CreateData['role']>().toEqualTypeOf<'admin' | 'user'>()
      expectTypeOf<CreateData['tags']>().toEqualTypeOf<string[]>()

      // Valid create with only required fields
      const validCreate: CreateData = {
        name: 'John',
        email: 'john@example.com',
        role: 'user',
        tags: [],
      }

      expect(validCreate).toBeDefined()
    })
  })

  describe('InferUpdateData Types', () => {
    test('all fields should be optional in update', () => {
      const entity = orm.entity('test', {
        name: orm.string(),
        email: orm.string(),
        age: orm.number(),
      }).build()

      type UpdateData = InferUpdateData<typeof entity.schema>

      // All fields should be optional
      const validUpdate1: UpdateData = {}
      const validUpdate2: UpdateData = { name: 'John' }
      const validUpdate3: UpdateData = { age: 30 }

      expect(validUpdate1).toBeDefined()
      expect(validUpdate2).toBeDefined()
      expect(validUpdate3).toBeDefined()
    })

    test('nullable fields should allow null and undefined', () => {
      const entity = orm.entity('test', {
        bio: orm.string().nullable(),
      }).build()

      type UpdateData = InferUpdateData<typeof entity.schema>

      // Should accept null and undefined
      const validUpdate1: UpdateData = { bio: 'Hello' }
      const validUpdate2: UpdateData = { bio: null }
      const validUpdate3: UpdateData = { bio: undefined }

      expect(validUpdate1).toBeDefined()
      expect(validUpdate2).toBeDefined()
      expect(validUpdate3).toBeDefined()
    })

    test('enum fields should preserve literal types', () => {
      const entity = orm.entity('test', {
        role: orm.enum(['admin', 'user'] as const),
      }).build()

      type UpdateData = InferUpdateData<typeof entity.schema>

      // Optional but should still be literal type when provided
      expectTypeOf<UpdateData['role']>().toEqualTypeOf<'admin' | 'user' | undefined>()
    })
  })

  describe('Array Field Types', () => {
    test('string array should be string[]', () => {
      const entity = orm.entity('test', {
        tags: orm.array('string'),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['tags']>().toEqualTypeOf<string[]>()
    })

    test('number array should be number[]', () => {
      const entity = orm.entity('test', {
        scores: orm.array('number'),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['scores']>().toEqualTypeOf<number[]>()
    })

    test('boolean array should be boolean[]', () => {
      const entity = orm.entity('test', {
        flags: orm.array('boolean'),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['flags']>().toEqualTypeOf<boolean[]>()
    })

    test('nullable array should include null', () => {
      const entity = orm.entity('test', {
        tags: orm.array('string').nullable(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['tags']>().toEqualTypeOf<string[] | null>()
    })
  })

  describe('JSON Field Types', () => {
    test('typed jsonb should preserve generic type', () => {
      interface UserMeta {
        theme: 'light' | 'dark'
        notifications: boolean
      }

      const entity = orm.entity('test', {
        metadata: orm.jsonb<UserMeta>(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['metadata']>().toEqualTypeOf<UserMeta>()
    })

    test('nullable jsonb should include null', () => {
      interface UserMeta {
        foo: string
      }

      const entity = orm.entity('test', {
        metadata: orm.jsonb<UserMeta>().nullable(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['metadata']>().toEqualTypeOf<UserMeta | null>()
    })
  })

  describe('Other Field Types', () => {
    test('uuid field should be string', () => {
      const entity = orm.entity('test', {
        id: orm.uuid(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['id']>().toEqualTypeOf<string>()
    })

    test('timestamp field should be Date', () => {
      const entity = orm.entity('test', {
        createdAt: orm.timestamp(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['createdAt']>().toEqualTypeOf<Date>()
    })

    test('date field should be Date', () => {
      const entity = orm.entity('test', {
        birthDate: orm.date(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['birthDate']>().toEqualTypeOf<Date>()
    })

    test('blob field should be Uint8Array', () => {
      const entity = orm.entity('test', {
        data: orm.blob(),
      }).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['data']>().toEqualTypeOf<Uint8Array>()
    })
  })
})
