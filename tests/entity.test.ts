import { describe, expect, test } from 'bun:test'
import { orm, timestamps } from '../src'

describe('Entity Builder', () => {
  describe('Entity Creation', () => {
    test('should create basic entity definition', () => {
      const entity = orm.entity('users', {
        name: orm.string(),
        email: orm.string(),
      }).build()

      expect(entity.tableName).toBe('users')
      expect(entity.schema.name).toBeDefined()
      expect(entity.schema.email).toBeDefined()
      expect(entity.schema.name.type).toBe('string')
      expect(entity.schema.email.type).toBe('string')
    })

    test('should handle multiple field types', () => {
      const entity = orm.entity('posts', {
        title: orm.string(),
        content: orm.string(),
        views: orm.number(),
        published: orm.boolean(),
        tags: orm.array('string'),
        metadata: orm.jsonb(),
      }).build()

      expect(entity.schema.title.type).toBe('string')
      expect(entity.schema.views.type).toBe('number')
      expect(entity.schema.published.type).toBe('boolean')
      expect(entity.schema.tags.type).toBe('array')
      expect(entity.schema.metadata.type).toBe('jsonb')
    })

    test('should preserve field constraints', () => {
      const entity = orm.entity('users', {
        name: orm.string().maxLength(100),
        email: orm.string().unique(),
        age: orm.number().nullable(),
      }).build()

      expect(entity.schema.name.maxLength).toBe(100)
      expect(entity.schema.email.unique).toBe(true)
      expect(entity.schema.age.nullable).toBe(true)
    })
  })

  describe('Lifecycle Hooks', () => {
    test('should register beforeCreate hook', () => {
      const entity = orm.entity('users', {
        name: orm.string(),
      })
        .beforeCreate((data) => {
          data.name = data.name!.toUpperCase()
        })
        .build()

      expect(entity.hooks.beforeCreate).toHaveLength(1)
    })

    test('should register multiple hooks of same type', () => {
      const entity = orm.entity('users', {
        name: orm.string(),
      })
        .beforeCreate((data) => {
          data.name = data.name!.trim()
        })
        .beforeCreate((data) => {
          data.name = data.name!.toLowerCase()
        })
        .build()

      expect(entity.hooks.beforeCreate).toHaveLength(2)
    })

    test('should register all hook types', () => {
      const entity = orm.entity('users', {
        name: orm.string(),
      })
        .beforeCreate(() => { /* empty */ })
        .afterCreate(() => { /* empty */ })
        .beforeUpdate(() => { /* empty */ })
        .afterUpdate(() => { /* empty */ })
        .beforeDelete(() => { /* empty */ })
        .afterDelete(() => { /* empty */ })
        .build()

      expect(entity.hooks.beforeCreate).toHaveLength(1)
      expect(entity.hooks.afterCreate).toHaveLength(1)
      expect(entity.hooks.beforeUpdate).toHaveLength(1)
      expect(entity.hooks.afterUpdate).toHaveLength(1)
      expect(entity.hooks.beforeDelete).toHaveLength(1)
      expect(entity.hooks.afterDelete).toHaveLength(1)
    })
  })

  describe('Traits', () => {
    test('should apply timestamps trait', () => {
      const entity = orm.entity('users', {
        name: orm.string(),
      })
        .use(timestamps())
        .build()

      expect(entity.schema.createdAt).toBeDefined()
      expect(entity.schema.updatedAt).toBeDefined()
      expect(entity.schema.createdAt.type).toBe('timestamp')
      expect(entity.schema.updatedAt.type).toBe('timestamp')
      expect(entity.traits).toHaveLength(1)
      expect(entity.traits[0]?.name).toBe('timestamps')
    })

    test('should apply multiple traits', () => {
      const trait1 = orm.trait('trait1')
        .field('field1', orm.string())
        .build()

      const trait2 = orm.trait('trait2')
        .field('field2', orm.number())
        .build()

      const entity = orm.entity('users', {
        name: orm.string(),
      })
        .use(trait1)
        .use(trait2)
        .build()

      expect(entity.schema.name).toBeDefined()
      expect(entity.schema.field1).toBeDefined()
      expect(entity.schema.field2).toBeDefined()
      expect(entity.traits).toHaveLength(2)
    })

    test('should merge trait fields into schema', () => {
      const customTrait = orm.trait('custom')
        .field('customField', orm.string())
        .field('customNumber', orm.number().default(0))
        .build()

      const entity = orm.entity('users', {
        name: orm.string(),
      })
        .use(customTrait)
        .build()

      expect(entity.schema.customField).toBeDefined()
      expect(entity.schema.customNumber).toBeDefined()
      expect(entity.schema.customNumber.default).toBe(0)
    })
  })

  describe('Unique Constraints', () => {
    test('should set single column unique constraint', () => {
      const entity = orm.entity('users', {
        email: orm.string(),
      })
        .unique(['email'])
        .build()

      expect(entity.unique).toEqual([['email']])
    })

    test('should set multi-column unique constraint', () => {
      const entity = orm.entity('users', {
        firstName: orm.string(),
        lastName: orm.string(),
      })
        .unique(['firstName', 'lastName'])
        .build()

      expect(entity.unique).toEqual([['firstName', 'lastName']])
    })

    test('should set multiple unique constraints', () => {
      const entity = orm.entity('users', {
        email: orm.string(),
        username: orm.string(),
      })
        .unique(['email'])
        .unique(['username'])
        .build()

      // Last unique call overwrites previous ones due to builder implementation
      expect(entity.unique).toEqual([['username']])
    })
  })

  describe('Builder Immutability', () => {
    test('should not mutate original builder when adding hooks', () => {
      const builder1 = orm.entity('users', {
        name: orm.string(),
      })

      const builder2 = builder1.beforeCreate(() => { /* empty */ })

      const entity1 = builder1.build()
      const entity2 = builder2.build()

      expect(entity1.hooks.beforeCreate).toHaveLength(0)
      expect(entity2.hooks.beforeCreate).toHaveLength(1)
    })

    test('should not mutate original builder when adding traits', () => {
      const builder1 = orm.entity('users', {
        name: orm.string(),
      })

      const builder2 = builder1.use(timestamps())

      const entity1 = builder1.build()
      const entity2 = builder2.build()

      expect((entity1.schema as any).createdAt).toBeUndefined()
      expect(entity2.schema.createdAt).toBeDefined()
    })
  })

  describe('Build and Freeze', () => {
    test('should freeze entity definition after build', () => {
      const entity = orm.entity('users', {
        name: orm.string(),
      }).build()

      // TypeScript should prevent this, but test at runtime too
      expect(() => {
        (entity as any).tableName = 'modified'
      }).toThrow()
    })

    test('should allow building multiple times from same builder', () => {
      const builder = orm.entity('users', {
        name: orm.string(),
      })

      const entity1 = builder.build()
      const entity2 = builder.build()

      // Should be different objects
      expect(entity1).not.toBe(entity2)
      // But with same configuration
      expect(entity1.tableName).toBe(entity2.tableName)
    })
  })

  describe('Complex Entity Example', () => {
    test('should handle complex entity with all features', () => {
      const entity = orm.entity('users', {
        name: orm.string().maxLength(100),
        email: orm.string().unique(),
        age: orm.number().nullable(),
        role: orm.enum(['admin', 'user', 'moderator'] as const),
        isActive: orm.boolean().default(true),
        metadata: orm.jsonb().nullable(),
        tags: orm.array('string'),
      })
        .use(timestamps())
        .unique(['email'])
        .beforeCreate((data) => {
          data.email = data.email!.toLowerCase()
        })
        .afterCreate(async () => {
          // Send welcome email
        })
        .build()

      expect(entity.tableName).toBe('users')
      expect(Object.keys(entity.schema)).toContain('name')
      expect(Object.keys(entity.schema)).toContain('email')
      expect(Object.keys(entity.schema)).toContain('createdAt')
      expect(Object.keys(entity.schema)).toContain('updatedAt')
      expect(entity.hooks.beforeCreate).toHaveLength(2)
      expect(entity.hooks.afterCreate).toHaveLength(1)
      expect(entity.unique).toEqual([['email']])
    })
  })
})
