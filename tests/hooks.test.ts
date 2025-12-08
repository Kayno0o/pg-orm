import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTestTable, getTestSchema, orm, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Lifecycle Hooks', () => {
  const schema = getTestSchema()

  beforeAll(async () => {
    await setupTestDatabase({ schema })
  })

  afterAll(async () => {
    await teardownTestDatabase({ schema })
  })

  describe('beforeCreate Hook', () => {
    test('should execute before entity creation', async () => {
      let hookCalled = false

      const User = orm.entity('test_before_create', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeCreate((data) => {
          hookCalled = true
          expect(data.name).toBe('Test User')
        })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)

      await users.create({ name: 'Test User', email: 'test@example.com' })
      expect(hookCalled).toBe(true)
    })

    test('should allow modifying data in beforeCreate', async () => {
      const User = orm.entity('test_before_create_modify', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeCreate((data) => {
          data.email = data.email!.toLowerCase()
          data.name = data.name!.trim()
        })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({
        name: '  Spaced Name  ',
        email: 'UPPERCASE@EXAMPLE.COM',
      })

      expect(user.email).toBe('uppercase@example.com')
      expect(user.name).toBe('Spaced Name')
    })

    test('should execute multiple beforeCreate hooks in order', async () => {
      const callOrder: number[] = []

      const User = orm.entity('test_multiple_before_create', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeCreate(() => { callOrder.push(1) })
        .beforeCreate(() => { callOrder.push(2) })
        .beforeCreate(() => { callOrder.push(3) })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)

      await users.create({ name: 'Test', email: 'test@example.com' })
      expect(callOrder).toEqual([1, 2, 3])
    })
  })

  describe('afterCreate Hook', () => {
    test('should execute after entity creation', async () => {
      let hookCalled = false
      let createdId: number | undefined

      const User = orm.entity('test_after_create', {
        name: orm.string(),
        email: orm.string(),
      })
        .afterCreate((entity) => {
          hookCalled = true
          createdId = entity.id
          expect(entity.id).toBeGreaterThan(0)
          expect(entity.name).toBe('Test User')
        })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({ name: 'Test User', email: 'test@example.com' })

      expect(hookCalled).toBe(true)
      expect(createdId).toBe(user.id)
    })

    test('should handle async afterCreate hook', async () => {
      let asyncTaskCompleted = false

      const User = orm.entity('test_after_create_async', {
        name: orm.string(),
        email: orm.string(),
      })
        .afterCreate(async () => {
          await new Promise(resolve => setTimeout(resolve, 10))
          asyncTaskCompleted = true
        })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)

      await users.create({ name: 'Test', email: 'test@example.com' })
      expect(asyncTaskCompleted).toBe(true)
    })
  })

  describe('beforeUpdate Hook', () => {
    test('should execute before entity update', async () => {
      let hookCalled = false

      const User = orm.entity('test_before_update', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeUpdate((id, data) => {
          hookCalled = true
          expect(id).toBeGreaterThan(0)
          expect(data.name).toBe('Updated Name')
        })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({ name: 'Original', email: 'test@example.com' })

      await users.update(user.id, { name: 'Updated Name' })
      expect(hookCalled).toBe(true)
    })

    test('should allow modifying update data', async () => {
      const User = orm.entity('test_before_update_modify', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeUpdate((_id, data) => {
          data.email &&= data.email.toLowerCase()
        })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({ name: 'Test', email: 'original@example.com' })
      const updated = await users.update(user.id, { email: 'UPDATED@EXAMPLE.COM' })

      expect(updated.email).toBe('updated@example.com')
    })
  })

  describe('afterUpdate Hook', () => {
    test('should execute after entity update', async () => {
      let hookCalled = false
      let updatedEntity: any = null

      const User = orm.entity('test_after_update', {
        name: orm.string(),
        email: orm.string(),
      })
        .afterUpdate((entity) => {
          hookCalled = true
          updatedEntity = entity
        })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({ name: 'Original', email: 'test@example.com' })

      await users.update(user.id, { name: 'Updated' })

      expect(hookCalled).toBe(true)
      expect(updatedEntity.name).toBe('Updated')
      expect(updatedEntity.id).toBe(user.id)
    })
  })

  describe('beforeDelete Hook', () => {
    test('should execute before entity deletion', async () => {
      let hookCalled = false
      let deletedId: number | undefined

      const User = orm.entity('test_before_delete', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeDelete((id) => {
          hookCalled = true
          deletedId = id
        })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({ name: 'To Delete', email: 'delete@example.com' })

      await users.delete(user.id)
      expect(hookCalled).toBe(true)
      expect(deletedId).toBe(user.id)
    })

    test('should handle async beforeDelete hook', async () => {
      let cleanupCompleted = false

      const User = orm.entity('test_before_delete_async', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeDelete(async () => {
          await new Promise(resolve => setTimeout(resolve, 10))
          cleanupCompleted = true
        })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({ name: 'To Delete', email: 'delete@example.com' })

      await users.delete(user.id)
      expect(cleanupCompleted).toBe(true)
    })
  })

  describe('afterDelete Hook', () => {
    test('should execute after entity deletion', async () => {
      let hookCalled = false
      let deletedId: number | undefined

      const User = orm.entity('test_after_delete', {
        name: orm.string(),
        email: orm.string(),
      })
        .afterDelete((id) => {
          hookCalled = true
          deletedId = id
        })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({ name: 'To Delete', email: 'delete@example.com' })
      const userId = user.id

      await users.delete(userId)
      expect(hookCalled).toBe(true)
      expect(deletedId).toBe(userId)

      // Verify entity is actually deleted
      const found = await users.find(userId)

      expect(found).toBeNull()
    })
  })

  describe('Hook Execution Order', () => {
    test('should execute hooks in correct order for create', async () => {
      const executionOrder: string[] = []

      const User = orm.entity('test_hook_order_create', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeCreate(() => { executionOrder.push('beforeCreate1') })
        .beforeCreate(() => { executionOrder.push('beforeCreate2') })
        .afterCreate(() => { executionOrder.push('afterCreate1') })
        .afterCreate(() => { executionOrder.push('afterCreate2') })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)

      await users.create({ name: 'Test', email: 'test@example.com' })
      expect(executionOrder).toEqual([
        'beforeCreate1',
        'beforeCreate2',
        'afterCreate1',
        'afterCreate2',
      ])
    })

    test('should execute hooks in correct order for update', async () => {
      const executionOrder: string[] = []

      const User = orm.entity('test_hook_order_update', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeUpdate(() => { executionOrder.push('beforeUpdate1') })
        .beforeUpdate(() => { executionOrder.push('beforeUpdate2') })
        .afterUpdate(() => { executionOrder.push('afterUpdate1') })
        .afterUpdate(() => { executionOrder.push('afterUpdate2') })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({ name: 'Test', email: 'test@example.com' })

      await users.update(user.id, { name: 'Updated' })
      expect(executionOrder).toEqual([
        'beforeUpdate1',
        'beforeUpdate2',
        'afterUpdate1',
        'afterUpdate2',
      ])
    })

    test('should execute hooks in correct order for delete', async () => {
      const executionOrder: string[] = []

      const User = orm.entity('test_hook_order_delete', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeDelete(() => { executionOrder.push('beforeDelete1') })
        .beforeDelete(() => { executionOrder.push('beforeDelete2') })
        .afterDelete(() => { executionOrder.push('afterDelete1') })
        .afterDelete(() => { executionOrder.push('afterDelete2') })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)
      const user = await users.create({ name: 'Test', email: 'test@example.com' })

      await users.delete(user.id)
      expect(executionOrder).toEqual([
        'beforeDelete1',
        'beforeDelete2',
        'afterDelete1',
        'afterDelete2',
      ])
    })
  })

  describe('Complex Hook Scenarios', () => {
    test('should handle all hooks together', async () => {
      const events: string[] = []

      const User = orm.entity('test_all_hooks', {
        name: orm.string(),
        email: orm.string(),
      })
        .beforeCreate(() => { events.push('beforeCreate') })
        .afterCreate(() => { events.push('afterCreate') })
        .beforeUpdate(() => { events.push('beforeUpdate') })
        .afterUpdate(() => { events.push('afterUpdate') })
        .beforeDelete(() => { events.push('beforeDelete') })
        .afterDelete(() => { events.push('afterDelete') })
        .build()

      await createTestTable(User)

      const users = orm.repo(User)

      const user = await users.create({ name: 'Test', email: 'test@example.com' })

      await users.update(user.id, { name: 'Updated' })
      await users.delete(user.id)

      expect(events).toEqual([
        'beforeCreate',
        'afterCreate',
        'beforeUpdate',
        'afterUpdate',
        'beforeDelete',
        'afterDelete',
      ])
    })
  })
})
