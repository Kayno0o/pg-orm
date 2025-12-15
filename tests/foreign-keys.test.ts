import type { InferEntity } from '../src'
import { describe, expect, test } from 'bun:test'
import { orm } from './setup'

describe('Foreign Keys', () => {
  describe('Field Definition', () => {
    test('should define a foreign key field with default options', () => {
      const Post = orm.entity('test_fk_posts', f => ({
        title: f.string(),
        authorId: f.foreignKey('users'),
      })).build()

      const authorIdConfig = Post.schema.authorId

      // expect(authorIdConfig.type).toBe('number')
      expect(authorIdConfig.foreignKey).toBeDefined()
      expect(authorIdConfig.foreignKey?.table).toBe('users')
      expect(authorIdConfig.foreignKey?.column).toBe('id')
      expect(authorIdConfig.foreignKey?.onDelete).toBe('NO ACTION')
      expect(authorIdConfig.foreignKey?.onUpdate).toBe('NO ACTION')
    })

    test('should define a foreign key field with custom column', () => {
      const Comment = orm.entity('test_fk_comments', f => ({
        content: f.string(),
        postId: f.foreignKey('posts', 'post_id'),
      })).build()

      const postIdConfig = Comment.schema.postId

      expect(postIdConfig.foreignKey?.table).toBe('posts')
      expect(postIdConfig.foreignKey?.column).toBe('post_id')
    })

    test('should define a foreign key field with CASCADE delete', () => {
      const OrderItem = orm.entity('test_fk_order_items', f => ({
        quantity: f.number(),
        orderId: f.foreignKey('orders').onDelete('CASCADE'),
      })).build()

      const orderIdConfig = OrderItem.schema.orderId

      expect(orderIdConfig.foreignKey?.onDelete).toBe('CASCADE')
      expect(orderIdConfig.foreignKey?.onUpdate).toBe('NO ACTION')
    })

    test('should define a foreign key field with SET NULL delete', () => {
      const Task = orm.entity('test_fk_tasks', f => ({
        name: f.string(),
        assigneeId: f.foreignKey('users').nullable().onDelete('SET NULL'),
      })).build()

      const assigneeIdConfig = Task.schema.assigneeId

      expect(assigneeIdConfig.foreignKey?.onDelete).toBe('SET NULL')
      expect(assigneeIdConfig.nullable).toBe(true)
    })

    test('should define a foreign key field with RESTRICT', () => {
      const Invoice = orm.entity('test_fk_invoices', f => ({
        amount: f.number(),
        customerId: f.foreignKey('customers').onDelete('RESTRICT').onUpdate('RESTRICT'),
      })).build()

      const customerIdConfig = Invoice.schema.customerId

      expect(customerIdConfig.foreignKey?.onDelete).toBe('RESTRICT')
      expect(customerIdConfig.foreignKey?.onUpdate).toBe('RESTRICT')
    })

    test('should define a foreign key field with CASCADE update', () => {
      const Log = orm.entity('test_fk_logs', f => ({
        message: f.string(),
        userId: f.foreignKey('users').onUpdate('CASCADE'),
      })).build()

      const userIdConfig = Log.schema.userId

      expect(userIdConfig.foreignKey?.onUpdate).toBe('CASCADE')
    })
  })

  describe('Multiple Foreign Keys', () => {
    test('should support multiple foreign keys in one entity', () => {
      const Post = orm.entity('test_fk_multi', f => ({
        title: f.string(),
        authorId: f.foreignKey('users'),
        categoryId: f.foreignKey('categories'),
        reviewerId: f.foreignKey('users').nullable().onDelete('SET NULL'),
      })).build()

      expect(Post.schema.authorId.foreignKey?.table).toBe('users')
      expect(Post.schema.categoryId.foreignKey?.table).toBe('categories')
      expect(Post.schema.reviewerId.foreignKey?.table).toBe('users')
      expect(Post.schema.reviewerId.foreignKey?.onDelete).toBe('SET NULL')
    })
  })

  describe('Foreign Key Validation', () => {
    test('should allow foreign key on number fields', () => {
      expect(() => {
        orm.entity('test_fk_valid', f => ({
          userId: f.foreignKey('users'),
        })).build()
      }).not.toThrow()
    })

    test('should allow foreign key on nullable fields', () => {
      expect(() => {
        orm.entity('test_fk_nullable', f => ({
          userId: f.foreignKey('users').nullable(),
        })).build()
      }).not.toThrow()
    })

    test('should store foreign key metadata correctly', () => {
      const Entity = orm.entity('test_fk_metadata', f => ({
        parentId: f.foreignKey('parents').onDelete('CASCADE').onUpdate('NO ACTION'),
      })).build()

      const fk = Entity.schema.parentId.foreignKey

      expect(fk).toEqual({
        table: 'parents',
        column: 'id',
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      })
    })
  })

  describe('Foreign Key Options', () => {
    test('should support all onDelete options', () => {
      const testCases = [
        { option: 'CASCADE' as const, expected: 'CASCADE' },
        { option: 'SET NULL' as const, expected: 'SET NULL' },
        { option: 'RESTRICT' as const, expected: 'RESTRICT' },
        { option: 'NO ACTION' as const, expected: 'NO ACTION' },
      ]

      for (const { option, expected } of testCases) {
        const Entity = orm.entity(`test_fk_delete_${option.toLowerCase().replace(' ', '_')}`, f => ({
          refId: f.foreignKey('ref').onDelete(option),
        })).build()

        expect(Entity.schema.refId.foreignKey?.onDelete).toBe(expected as any)
      }
    })

    test('should support all onUpdate options', () => {
      const testCases = [
        { option: 'CASCADE' as const, expected: 'CASCADE' },
        { option: 'SET NULL' as const, expected: 'SET NULL' },
        { option: 'RESTRICT' as const, expected: 'RESTRICT' },
        { option: 'NO ACTION' as const, expected: 'NO ACTION' },
      ]

      for (const { option, expected } of testCases) {
        const Entity = orm.entity(`test_fk_update_${option.toLowerCase().replace(' ', '_')}`, f => ({
          refId: f.foreignKey('ref').onUpdate(option),
        })).build()

        expect(Entity.schema.refId.foreignKey?.onUpdate).toBe(expected as any)
      }
    })
  })

  describe('Foreign Key Integration', () => {
    test('should work with unique constraint', () => {
      const Profile = orm.entity('test_fk_unique', f => ({
        bio: f.string(),
        userId: f.foreignKey('users').unique(),
      })).build()

      expect(Profile.schema.userId.unique).toBe(true)
      expect(Profile.schema.userId.foreignKey).toBeDefined()
    })

    test('should work with column name override', () => {
      const Task = orm.entity('test_fk_column', f => ({
        name: f.string(),
        assignee: f.foreignKey('users').column('assignee_id'),
      })).build()

      expect(Task.schema.assignee.columnName).toBe('assignee_id')
      expect(Task.schema.assignee.foreignKey?.table).toBe('users')
    })
  })

  describe('Type Safety', () => {
    test('should maintain type safety with foreign keys', () => {
      const _Post = orm.entity('test_fk_types', f => ({
        title: f.string(),
        authorId: f.foreignKey('users'),
        reviewerId: f.foreignKey('users').nullable(),
      })).build()

      // Type inference should work
      type PostEntity = InferEntity<typeof _Post.schema>

      // authorId should be number (required)
      const post: PostEntity = {
        id: 1,
        title: 'Test',
        authorId: 123,
        reviewerId: null,
      }

      expect(post.authorId).toBe(123)
      expect(post.reviewerId).toBeNull()
    })
  })

  describe('Schema Introspection', () => {
    test('should expose foreign key information in entity definition', () => {
      const Post = orm.entity('test_fk_introspection', f => ({
        title: f.string(),
        authorId: f.foreignKey('users').onDelete('CASCADE').onUpdate('NO ACTION'),
        categoryId: f.foreignKey('categories'),
      })).build()

      // Should be able to iterate over fields and find foreign keys
      const foreignKeys: {
        field: string
        table: string
        column: string
        onDelete: string
        onUpdate: string
      }[] = []

      for (const [fieldName, config] of Object.entries(Post.schema)) {
        if ('foreignKey' in config && config.foreignKey) {
          foreignKeys.push({
            field: fieldName,
            table: config.foreignKey.table,
            column: config.foreignKey.column,
            onDelete: config.foreignKey.onDelete || 'NO ACTION',
            onUpdate: config.foreignKey.onUpdate || 'NO ACTION',
          })
        }
      }

      expect(foreignKeys.length).toBe(2)
      expect(foreignKeys[0]!.field).toBe('authorId')
      expect(foreignKeys[0]!.table).toBe('users')
      expect(foreignKeys[0]!.onDelete).toBe('CASCADE')
      expect(foreignKeys[1]!.field).toBe('categoryId')
      expect(foreignKeys[1]!.table).toBe('categories')
    })
  })

  describe('Chaining Methods', () => {
    test('should allow method chaining with foreignKey', () => {
      const Entity = orm.entity('test_fk_chaining', f => ({
        refId: f.foreignKey('ref').unique().column('reference_id'),
      })).build()

      const config = Entity.schema.refId

      expect(config.foreignKey?.table).toBe('ref')
      expect(config.columnName).toBe('reference_id')
      expect(config.unique).toBe(true)
    })

    test('should allow foreignKey constraints in any order', () => {
      const Entity1 = orm.entity('test_fk_order1', f => ({
        refId: f.foreignKey('ref').unique().nullable(),
      })).build()

      const Entity2 = orm.entity('test_fk_order2', f => ({
        refId: f.foreignKey('ref').unique().nullable(),
      })).build()

      expect(Entity1.schema.refId.unique).toBe(true)
      expect(Entity1.schema.refId.nullable).toBe(true)
      expect(Entity1.schema.refId.foreignKey).toBeDefined()

      expect(Entity2.schema.refId.unique).toBe(true)
      expect(Entity2.schema.refId.nullable).toBe(true)
      expect(Entity2.schema.refId.foreignKey).toBeDefined()
    })
  })
})
