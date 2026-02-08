/* eslint-disable unused-imports/no-unused-vars */
import type { InferCreateData, InferEntity, InferUpdateData } from '../src'
import { describe, expect, expectTypeOf, test } from 'bun:test'
import { orm } from './setup'

describe('Type System', () => {
  describe('Field Nullable Literal Types', () => {
    test('non-nullable field should have nullable: false as literal type', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(),
      })).build()

      // The nullable property should be literal false, not boolean
      expectTypeOf<typeof entity.schema.name.nullable>().toEqualTypeOf<false>()
    })

    test('nullable field should have nullable: true as literal type', () => {
      const entity = orm.entity('test', f => ({
        name: f.string().nullable(),
      })).build()

      // The nullable property should be literal true, not boolean
      expectTypeOf<typeof entity.schema.name.nullable>().toEqualTypeOf<true>()
    })

    test('number field nullable literal type', () => {
      const entity = orm.entity('test', f => ({
        required: f.number(),
        optional: f.number().nullable(),
      })).build()

      expectTypeOf<typeof entity.schema.required.nullable>().toEqualTypeOf<false>()
      expectTypeOf<typeof entity.schema.optional.nullable>().toEqualTypeOf<true>()
    })

    test('boolean field nullable literal type', () => {
      const entity = orm.entity('test', f => ({
        required: f.boolean(),
        optional: f.boolean().nullable(),
      })).build()

      expectTypeOf<typeof entity.schema.required.nullable>().toEqualTypeOf<false>()
      expectTypeOf<typeof entity.schema.optional.nullable>().toEqualTypeOf<true>()
    })
  })

  describe('Enum Literal Types', () => {
    test('enum should preserve literal tuple type', () => {
      const entity = orm.entity('test', f => ({
        role: f.enum(['admin', 'user', 'moderator'] as const),
      })).build()

      // Should be the exact literal tuple, not string[]
      expectTypeOf<typeof entity.schema.role.values>().toEqualTypeOf<readonly ['admin', 'user', 'moderator']>()
    })

    test('enum with different values should preserve literal types', () => {
      const entity = orm.entity('test', f => ({
        status: f.enum(['pending', 'approved', 'rejected'] as const),
      })).build()

      expectTypeOf<typeof entity.schema.status.values>().toEqualTypeOf<readonly ['pending', 'approved', 'rejected']>()
    })

    test('nullable enum should preserve both nullable and values as literals', () => {
      const entity = orm.entity('test', f => ({
        optionalRole: f.enum(['admin', 'user'] as const).nullable(),
      })).build()

      expectTypeOf<typeof entity.schema.optionalRole.nullable>().toEqualTypeOf<true>()
      expectTypeOf<typeof entity.schema.optionalRole.values>().toEqualTypeOf<readonly ['admin', 'user']>()
    })
  })

  describe('InferEntity Types', () => {
    test('non-nullable fields should be non-nullable in entity', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(),
        age: f.number(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      // name and age should be non-nullable (no null or undefined in type)
      expectTypeOf<Entity['name']>().toEqualTypeOf<string>()
      expectTypeOf<Entity['age']>().toEqualTypeOf<number>()
    })

    test('nullable fields should include null (database-aligned)', () => {
      const entity = orm.entity('test', f => ({
        bio: f.string().nullable(),
        score: f.number().nullable(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      // nullable fields should include null only (database semantics, not undefined)
      expectTypeOf<Entity['bio']>().toEqualTypeOf<string | null>()
      expectTypeOf<Entity['score']>().toEqualTypeOf<number | null>()
    })

    test('enum fields should use literal union type', () => {
      const entity = orm.entity('test', f => ({
        role: f.enum(['admin', 'user', 'moderator'] as const),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      // Should be literal union, not string
      expectTypeOf<Entity['role']>().toEqualTypeOf<'admin' | 'user' | 'moderator'>()
    })

    test('nullable enum should be literal union | null', () => {
      const entity = orm.entity('test', f => ({
        role: f.enum(['admin', 'user'] as const).nullable(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['role']>().toEqualTypeOf<'admin' | 'user' | null>()
    })

    test('mixed nullable and non-nullable fields', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(),
        email: f.string(),
        age: f.number().nullable(),
        bio: f.string().nullable(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['name']>().toEqualTypeOf<string>()
      expectTypeOf<Entity['email']>().toEqualTypeOf<string>()
      expectTypeOf<Entity['age']>().toEqualTypeOf<number | null>()
      expectTypeOf<Entity['bio']>().toEqualTypeOf<string | null>()
    })
  })

  describe('InferCreateData Types', () => {
    test('non-nullable fields should be required', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(),
        email: f.string(),
      })).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // name and email should not be optional
      expectTypeOf<CreateData['name']>().toEqualTypeOf<string>()
      expectTypeOf<CreateData['email']>().toEqualTypeOf<string>()
    })

    test('nullable fields should be optional', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(),
        bio: f.string().nullable(),
        age: f.number().nullable(),
      })).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // name is required (not optional)
      expectTypeOf<CreateData['name']>().toEqualTypeOf<string>()

      // bio and age are optional (can be omitted)
      const validCreate: CreateData = { name: 'John' }

      expect(validCreate).toBeDefined()
    })

    test('fields with defaults should be optional', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(),
        score: f.number().default(0),
        isActive: f.boolean().default(true),
      })).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // name is required (not optional)
      expectTypeOf<CreateData['name']>().toEqualTypeOf<string>()

      // score and isActive are optional
      const validCreate: CreateData = { name: 'John' }

      expect(validCreate).toBeDefined()
    })

    test('enum fields should use literal union type', () => {
      const entity = orm.entity('test', f => ({
        role: f.enum(['admin', 'user'] as const),
      })).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // Should be literal union, not string
      expectTypeOf<CreateData['role']>().toEqualTypeOf<'admin' | 'user'>()
    })

    test('complex schema with mixed field types', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(), // required
        email: f.string().unique(), // required
        age: f.number().nullable(), // optional (nullable)
        role: f.enum(['admin', 'user'] as const), // required
        bio: f.string().nullable(), // optional (nullable)
        score: f.number().default(0), // optional (has default)
        isActive: f.boolean().default(true), // optional (has default)
        tags: f.array('string'), // required
      })).build()

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
      const entity = orm.entity('test', f => ({
        name: f.string(),
        email: f.string(),
        age: f.number(),
      })).build()

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
      const entity = orm.entity('test', f => ({
        bio: f.string().nullable(),
      })).build()

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
      const entity = orm.entity('test', f => ({
        role: f.enum(['admin', 'user'] as const),
      })).build()

      type UpdateData = InferUpdateData<typeof entity.schema>

      // Optional but should still be literal type when provided
      expectTypeOf<UpdateData['role']>().toEqualTypeOf<'admin' | 'user' | undefined>()
    })
  })

  describe('Array Field Types', () => {
    test('string array should be string[]', () => {
      const entity = orm.entity('test', f => ({
        tags: f.array('string'),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['tags']>().toEqualTypeOf<string[]>()
    })

    test('number array should be number[]', () => {
      const entity = orm.entity('test', f => ({
        scores: f.array('number'),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['scores']>().toEqualTypeOf<number[]>()
    })

    test('boolean array should be boolean[]', () => {
      const entity = orm.entity('test', f => ({
        flags: f.array('boolean'),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['flags']>().toEqualTypeOf<boolean[]>()
    })

    test('nullable array should include null', () => {
      const entity = orm.entity('test', f => ({
        tags: f.array('string').nullable(),
      })).build()

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

      const entity = orm.entity('test', f => ({
        metadata: f.jsonb<UserMeta>(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['metadata']>().toEqualTypeOf<UserMeta>()
    })

    test('nullable jsonb should include null', () => {
      interface UserMeta {
        foo: string
      }

      const entity = orm.entity('test', f => ({
        metadata: f.jsonb<UserMeta>().nullable(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['metadata']>().toEqualTypeOf<UserMeta | null>()
    })
  })

  describe('Other Field Types', () => {
    test('uuid field should be string', () => {
      const entity = orm.entity('test', f => ({
        id: f.uuid(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['id']>().toEqualTypeOf<string>()
    })

    test('timestamp field should be Date', () => {
      const entity = orm.entity('test', f => ({
        createdAt: f.timestamp(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['createdAt']>().toEqualTypeOf<Date>()
    })

    test('date field should be Date', () => {
      const entity = orm.entity('test', f => ({
        birthDate: f.date(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['birthDate']>().toEqualTypeOf<Date>()
    })

    test('blob field should be Uint8Array', () => {
      const entity = orm.entity('test', f => ({
        data: f.blob(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['data']>().toEqualTypeOf<Uint8Array>()
    })
  })

  describe('Custom String Types', () => {
    test('string field with custom literal type should preserve type', () => {
      const entity = orm.entity('test', f => ({
        type: f.string<'app' | 'service' | 'library'>(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      // Should be literal union, not string
      expectTypeOf<Entity['type']>().toEqualTypeOf<'app' | 'service' | 'library'>()
    })

    test('regular string field should remain string', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      // Regular string field should still be string
      expectTypeOf<Entity['name']>().toEqualTypeOf<string>()
    })

    test('custom string type with nullable should include null', () => {
      const entity = orm.entity('test', f => ({
        environment: f.string<'dev' | 'staging' | 'prod'>().nullable(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['environment']>().toEqualTypeOf<'dev' | 'staging' | 'prod' | null>()
    })

    test('custom string type with default should preserve type', () => {
      const entity = orm.entity('test', f => ({
        status: f.string<'active' | 'inactive'>().default('active'),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['status']>().toEqualTypeOf<'active' | 'inactive'>()
    })

    test('custom string type with unique should preserve type', () => {
      const entity = orm.entity('test', f => ({
        role: f.string<'admin' | 'user' | 'guest'>().unique(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['role']>().toEqualTypeOf<'admin' | 'user' | 'guest'>()
    })

    test('custom string type in InferCreateData should be required', () => {
      const entity = orm.entity('test', f => ({
        type: f.string<'app' | 'service'>(),
      })).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // Should be required and preserve literal type
      expectTypeOf<CreateData['type']>().toEqualTypeOf<'app' | 'service'>()
    })

    test('nullable custom string type in InferCreateData should be optional', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(),
        environment: f.string<'dev' | 'staging' | 'prod'>().nullable(),
      })).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // environment should be optional
      const validCreate: CreateData = { name: 'Test' }

      expect(validCreate).toBeDefined()

      // When provided, should be the literal type or null
      expectTypeOf<CreateData['environment']>().toEqualTypeOf<'dev' | 'staging' | 'prod' | null | undefined>()
    })

    test('custom string type with default in InferCreateData should be optional', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(),
        status: f.string<'active' | 'inactive'>().default('active'),
      })).build()

      type CreateData = InferCreateData<typeof entity.schema>

      // status should be optional (has default)
      const validCreate: CreateData = { name: 'Test' }

      expect(validCreate).toBeDefined()
    })

    test('custom string type in InferUpdateData should be optional', () => {
      const entity = orm.entity('test', f => ({
        type: f.string<'app' | 'service'>(),
        status: f.string<'active' | 'inactive'>(),
      })).build()

      type UpdateData = InferUpdateData<typeof entity.schema>

      // All fields should be optional in update
      const validUpdate1: UpdateData = {}
      const validUpdate2: UpdateData = { type: 'app' }
      const validUpdate3: UpdateData = { status: 'active' }

      expect(validUpdate1).toBeDefined()
      expect(validUpdate2).toBeDefined()
      expect(validUpdate3).toBeDefined()

      // Should preserve literal types
      expectTypeOf<UpdateData['type']>().toEqualTypeOf<'app' | 'service' | undefined>()
      expectTypeOf<UpdateData['status']>().toEqualTypeOf<'active' | 'inactive' | undefined>()
    })

    test('mixed regular and custom string fields', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(), // regular string
        email: f.string(), // regular string
        role: f.string<'admin' | 'user' | 'guest'>(), // custom type
        status: f.string<'active' | 'inactive'>(), // custom type
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      // Regular strings should be string
      expectTypeOf<Entity['name']>().toEqualTypeOf<string>()
      expectTypeOf<Entity['email']>().toEqualTypeOf<string>()

      // Custom types should be literal unions
      expectTypeOf<Entity['role']>().toEqualTypeOf<'admin' | 'user' | 'guest'>()
      expectTypeOf<Entity['status']>().toEqualTypeOf<'active' | 'inactive'>()
    })

    test('complex schema with custom types', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(), // required regular string
        type: f.string<'app' | 'service' | 'library'>(), // required custom type
        environment: f.string<'dev' | 'staging' | 'prod'>().nullable(), // optional custom type
        status: f.string<'active' | 'inactive'>().default('active'), // optional custom type with default
        description: f.string().nullable(), // optional regular string
      })).build()

      type Entity = InferEntity<typeof entity.schema>
      type CreateData = InferCreateData<typeof entity.schema>
      type UpdateData = InferUpdateData<typeof entity.schema>

      // Entity types
      expectTypeOf<Entity['name']>().toEqualTypeOf<string>()
      expectTypeOf<Entity['type']>().toEqualTypeOf<'app' | 'service' | 'library'>()
      expectTypeOf<Entity['environment']>().toEqualTypeOf<'dev' | 'staging' | 'prod' | null>()
      expectTypeOf<Entity['status']>().toEqualTypeOf<'active' | 'inactive'>()
      expectTypeOf<Entity['description']>().toEqualTypeOf<string | null>()

      // CreateData - name and type are required
      const validCreate: CreateData = {
        name: 'Test App',
        type: 'app',
      }

      expect(validCreate).toBeDefined()

      // UpdateData - all fields are optional
      const validUpdate: UpdateData = {}

      expect(validUpdate).toBeDefined()
    })

    test('custom string type should work with builder methods chaining', () => {
      const entity = orm.entity('test', f => ({
        type: f.string<'app' | 'service'>().maxLength(100).minLength(3),
        status: f.string<'active' | 'inactive'>().unique().default('active'),
        environment: f.string<'dev' | 'prod'>().nullable().column('env'),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      // Custom types should be preserved through chaining
      expectTypeOf<Entity['type']>().toEqualTypeOf<'app' | 'service'>()
      expectTypeOf<Entity['status']>().toEqualTypeOf<'active' | 'inactive'>()
      expectTypeOf<Entity['environment']>().toEqualTypeOf<'dev' | 'prod' | null>()
    })

    test('custom string type with single literal should work', () => {
      const entity = orm.entity('test', f => ({
        constant: f.string<'fixed-value'>(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['constant']>().toEqualTypeOf<'fixed-value'>()
    })

    test('custom string type should be distinct from enum', () => {
      const entity = orm.entity('test', f => ({
        customString: f.string<'option1' | 'option2'>(),
        enumField: f.enum(['option1', 'option2'] as const),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      // Both should result in the same TypeScript type
      expectTypeOf<Entity['customString']>().toEqualTypeOf<'option1' | 'option2'>()
      expectTypeOf<Entity['enumField']>().toEqualTypeOf<'option1' | 'option2'>()

      // But the config types are different
      expect(entity.schema.customString.type).toBe('string')
      expect(entity.schema.enumField.type).toBe('enum')
    })
  })

  describe('Custom Number Types', () => {
    test('number field with custom literal type should preserve type', () => {
      const entity = orm.entity('test', f => ({
        priority: f.number<1 | 2 | 3>(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['priority']>().toEqualTypeOf<1 | 2 | 3>()
    })

    test('regular number field should remain number', () => {
      const entity = orm.entity('test', f => ({
        count: f.number(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['count']>().toEqualTypeOf<number>()
    })

    test('custom number type with nullable should include null', () => {
      const entity = orm.entity('test', f => ({
        rating: f.number<1 | 2 | 3 | 4 | 5>().nullable(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['rating']>().toEqualTypeOf<1 | 2 | 3 | 4 | 5 | null>()
    })

    test('custom number type with default should preserve type', () => {
      const entity = orm.entity('test', f => ({
        status: f.number<0 | 1>().default(0),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['status']>().toEqualTypeOf<0 | 1>()
    })

    test('custom number type in InferCreateData should be required', () => {
      const entity = orm.entity('test', f => ({
        priority: f.number<1 | 2 | 3>(),
      })).build()

      type CreateData = InferCreateData<typeof entity.schema>

      expectTypeOf<CreateData['priority']>().toEqualTypeOf<1 | 2 | 3>()
    })

    test('custom number type in InferUpdateData should be optional', () => {
      const entity = orm.entity('test', f => ({
        priority: f.number<1 | 2 | 3>(),
        rating: f.number<1 | 2 | 3 | 4 | 5>(),
      })).build()

      type UpdateData = InferUpdateData<typeof entity.schema>

      expectTypeOf<UpdateData['priority']>().toEqualTypeOf<1 | 2 | 3 | undefined>()
      expectTypeOf<UpdateData['rating']>().toEqualTypeOf<1 | 2 | 3 | 4 | 5 | undefined>()
    })

    test('custom number type with builder methods chaining', () => {
      const entity = orm.entity('test', f => ({
        priority: f.number<1 | 2 | 3>().min(1).max(3).integer(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['priority']>().toEqualTypeOf<1 | 2 | 3>()
    })
  })

  describe('Custom Boolean Types', () => {
    test('boolean field with literal true type', () => {
      const entity = orm.entity('test', f => ({
        alwaysTrue: f.boolean<true>(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['alwaysTrue']>().toEqualTypeOf<true>()
    })

    test('boolean field with literal false type', () => {
      const entity = orm.entity('test', f => ({
        alwaysFalse: f.boolean<false>(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['alwaysFalse']>().toEqualTypeOf<false>()
    })

    test('regular boolean field should remain boolean', () => {
      const entity = orm.entity('test', f => ({
        isActive: f.boolean(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['isActive']>().toEqualTypeOf<boolean>()
    })

    test('custom boolean type with nullable', () => {
      const entity = orm.entity('test', f => ({
        flag: f.boolean<true>().nullable(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['flag']>().toEqualTypeOf<true | null>()
    })

    test('custom boolean type in InferCreateData', () => {
      const entity = orm.entity('test', f => ({
        mustBeTrue: f.boolean<true>(),
      })).build()

      type CreateData = InferCreateData<typeof entity.schema>

      expectTypeOf<CreateData['mustBeTrue']>().toEqualTypeOf<true>()
    })
  })

  describe('Custom UUID Types', () => {
    test('uuid field with custom string literal type', () => {
      const entity = orm.entity('test', f => ({
        version: f.uuid<'v4' | 'v5'>(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['version']>().toEqualTypeOf<'v4' | 'v5'>()
    })

    test('regular uuid field should remain string', () => {
      const entity = orm.entity('test', f => ({
        id: f.uuid(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['id']>().toEqualTypeOf<string>()
    })

    test('custom uuid type with nullable', () => {
      const entity = orm.entity('test', f => ({
        optionalId: f.uuid<'custom-format'>().nullable(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['optionalId']>().toEqualTypeOf<'custom-format' | null>()
    })

    test('custom uuid type with builder methods chaining', () => {
      const entity = orm.entity('test', f => ({
        id: f.uuid<'v4' | 'v5'>().unique(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>

      expectTypeOf<Entity['id']>().toEqualTypeOf<'v4' | 'v5'>()
    })
  })

  describe('Mixed Custom Types', () => {
    test('entity with multiple custom type fields', () => {
      const entity = orm.entity('test', f => ({
        name: f.string(),
        type: f.string<'app' | 'service'>(),
        priority: f.number<1 | 2 | 3>(),
        count: f.number(),
        isActive: f.boolean(),
        requiresAuth: f.boolean<true>(),
        uuid: f.uuid(),
        versionTag: f.uuid<'v4'>(),
      })).build()

      type Entity = InferEntity<typeof entity.schema>
      type CreateData = InferCreateData<typeof entity.schema>

      // Custom types preserved
      expectTypeOf<Entity['type']>().toEqualTypeOf<'app' | 'service'>()
      expectTypeOf<Entity['priority']>().toEqualTypeOf<1 | 2 | 3>()
      expectTypeOf<Entity['requiresAuth']>().toEqualTypeOf<true>()
      expectTypeOf<Entity['versionTag']>().toEqualTypeOf<'v4'>()

      // Regular types remain unchanged
      expectTypeOf<Entity['name']>().toEqualTypeOf<string>()
      expectTypeOf<Entity['count']>().toEqualTypeOf<number>()
      expectTypeOf<Entity['isActive']>().toEqualTypeOf<boolean>()
      expectTypeOf<Entity['uuid']>().toEqualTypeOf<string>()

      // CreateData also preserves types
      expectTypeOf<CreateData['type']>().toEqualTypeOf<'app' | 'service'>()
      expectTypeOf<CreateData['priority']>().toEqualTypeOf<1 | 2 | 3>()
      expectTypeOf<CreateData['requiresAuth']>().toEqualTypeOf<true>()
    })
  })
})
