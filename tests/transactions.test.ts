import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import { setupTestDatabase, setupTestSuite, teardownTestDatabase, teardownTestSuite, testData } from './setup'

const User = orm.entity('test_tx_users', {
  name: orm.string(),
  email: orm.string().unique(),
}).build()

const Post = orm.entity('test_tx_posts', {
  title: orm.string(),
  content: orm.string(),
  authorId: orm.number(),
}).build()

describe('Transactions', () => {
  let users: ReturnType<typeof orm.repo<typeof User.schema>>
  let posts: ReturnType<typeof orm.repo<typeof Post.schema>>

  beforeAll(async () => {
    // Register repositories before connecting to enable auto-migration
    users = orm.repo(User)
    posts = orm.repo(Post)
    await setupTestDatabase()
    setupTestSuite('transactions')
  })

  afterAll(async () => {
    teardownTestSuite('transactions')
    await teardownTestDatabase()
  })

  describe('Repository-Scoped Transactions', () => {
    test('should commit successful transaction', async () => {
      let createdUser: any = null

      await users.transaction(async (txUsers) => {
        createdUser = await txUsers.create({
          name: 'TX User',
          email: testData.user.valid().email,
        })
      })

      // Verify entity exists after commit
      const found = await users.find(createdUser.id)

      expect(found).not.toBeNull()
      expect(found?.name).toBe('TX User')

      // Cleanup after test
      await users.delete(createdUser.id)
    })

    test('should rollback failed transaction', async () => {
      let createdId: number | null = null

      try {
        await users.transaction(async (txUsers) => {
          const user = await txUsers.create({
            name: 'Will Rollback',
            email: testData.user.valid().email,
          })

          createdId = user.id
          throw new Error('Force rollback')
        })
      }
      catch (error) {
        // Expected error
      }

      // Verify entity does not exist after rollback
      if (createdId) {
        const found = await users.find(createdId)

        expect(found).toBeNull()
      }
      // No cleanup needed - rollback already deleted it
    })

    test('should handle multiple operations in transaction', async () => {
      const createdIds: number[] = []

      await users.transaction(async (txUsers) => {
        const user1 = await txUsers.create({
          name: 'User 1',
          email: testData.user.valid().email,
        })

        createdIds.push(user1.id)

        const user2 = await txUsers.create({
          name: 'User 2',
          email: testData.user.valid().email,
        })

        createdIds.push(user2.id)

        await txUsers.update(user1.id, { name: 'Updated User 1' })
      })

      // Verify all operations committed
      const user1 = await users.find(createdIds[0] as number)
      const user2 = await users.find(createdIds[1] as number)

      expect(user1?.name).toBe('Updated User 1')
      expect(user2?.name).toBe('User 2')

      // Cleanup
      await users.deleteMany(createdIds)
    })

    test('should rollback all operations on error', async () => {
      const createdIds: number[] = []

      try {
        await users.transaction(async (txUsers) => {
          const user1 = await txUsers.create({
            name: 'User 1',
            email: testData.user.valid().email,
          })

          createdIds.push(user1.id)

          const user2 = await txUsers.create({
            name: 'User 2',
            email: testData.user.valid().email,
          })

          createdIds.push(user2.id)

          throw new Error('Rollback all')
        })
      }
      catch (error) {
        // Expected error
      }

      // Verify no entities exist
      const found1 = await users.find(createdIds[0] as number)
      const found2 = await users.find(createdIds[1] as number)

      expect(found1).toBeNull()
      expect(found2).toBeNull()
      // No cleanup needed - rollback handled it
    })
  })

  describe('Global Transactions with Multiple Repositories', () => {
    test('should commit global transaction', async () => {
      let userId: number | undefined
      let postId: number | undefined

      await orm.transaction(async (tx) => {
        const txUsers = users.withTransaction(tx)
        const txPosts = posts.withTransaction(tx)

        const user = await txUsers.create({
          name: 'Author',
          email: testData.user.valid().email,
        })

        userId = user.id

        const post = await txPosts.create({
          title: 'Post in TX',
          content: 'Content',
          authorId: user.id,
        })

        postId = post.id
      })

      // Verify both entities exist
      const foundUser = await users.find(userId!)
      const foundPost = await posts.find(postId!)

      expect(foundUser).not.toBeNull()
      expect(foundPost).not.toBeNull()
      expect(foundPost?.authorId).toBe(userId)

      // Cleanup
      await posts.delete(postId!)
      await users.delete(userId!)
    })

    test('should rollback global transaction on error', async () => {
      let userId: number | null = null
      let postId: number | null = null

      try {
        await orm.transaction(async (tx) => {
          const txUsers = users.withTransaction(tx)
          const txPosts = posts.withTransaction(tx)

          const user = await txUsers.create({
            name: 'Author',
            email: testData.user.valid().email,
          })

          userId = user.id

          const post = await txPosts.create({
            title: 'Post in TX',
            content: 'Content',
            authorId: user.id,
          })

          postId = post.id

          throw new Error('Rollback both')
        })
      }
      catch (error) {
        // Expected error
      }

      // Verify no entities exist
      if (userId) {
        const foundUser = await users.find(userId)

        expect(foundUser).toBeNull()
      }

      if (postId) {
        const foundPost = await posts.find(postId)

        expect(foundPost).toBeNull()
      }
      // No cleanup needed - rollback handled it
    })

    test('should handle complex multi-repo transaction', async () => {
      let userId: number | undefined
      const postIds: number[] = []

      await orm.transaction(async (tx) => {
        const txUsers = users.withTransaction(tx)
        const txPosts = posts.withTransaction(tx)

        // Create user
        const user = await txUsers.create({
          name: 'Multi Author',
          email: testData.user.valid().email,
        })

        userId = user.id

        // Create multiple posts
        const post1 = await txPosts.create({
          title: 'Post 1',
          content: 'Content 1',
          authorId: user.id,
        })

        postIds.push(post1.id)

        const post2 = await txPosts.create({
          title: 'Post 2',
          content: 'Content 2',
          authorId: user.id,
        })

        postIds.push(post2.id)

        // Update user
        await txUsers.update(user.id, { name: 'Updated Multi Author' })
      })

      // Verify all operations succeeded
      const foundUser = await users.find(userId!)

      expect(foundUser?.name).toBe('Updated Multi Author')

      const foundPosts = await posts.query().where('authorId', '=', userId!).execute()

      expect(foundPosts.length).toBe(2)

      // Cleanup
      await posts.deleteMany(postIds)
      await users.delete(userId!)
    })
  })

  describe('Transaction Isolation', () => {
    test('should isolate transaction from non-transactional reads', async () => {
      let createdId: number | undefined

      // This test demonstrates that within a transaction, changes are isolated
      // until committed (though this behavior may vary based on isolation level)

      await users.transaction(async (txUsers) => {
        const created = await txUsers.create({
          name: 'Isolated User',
          email: testData.user.valid().email,
        })

        createdId = created.id

        // Within transaction, we can see the created user
        const txCount = await txUsers.query().where('id', '=', created.id).count()

        expect(txCount).toBe(1)
      })

      // After commit, we can see it from outside
      const found = await users.find(createdId!)

      expect(found).not.toBeNull()

      // Cleanup
      await users.delete(createdId!)
    })
  })

  describe('Transaction Error Handling', () => {
    test('should propagate errors from transaction', async () => {
      let errorCaught = false

      try {
        await users.transaction(async (txUsers) => {
          await txUsers.create({
            name: 'User',
            email: testData.user.valid().email,
          })

          throw new Error('Custom error')
        })
      }
      catch (error) {
        errorCaught = true
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('Custom error')
      }

      expect(errorCaught).toBe(true)
      // No cleanup needed - transaction was rolled back
    })

    test('should handle database errors in transaction', async () => {
      let errorCaught = false
      const uniqueEmail = testData.user.valid().email

      try {
        await users.transaction(async (txUsers) => {
          await txUsers.create({
            name: 'User 1',
            email: uniqueEmail,
          })

          // Try to create duplicate (unique constraint violation)
          await txUsers.create({
            name: 'User 2',
            email: uniqueEmail,
          })
        })
      }
      catch (error) {
        errorCaught = true
      }

      expect(errorCaught).toBe(true)

      // Verify no entities were created (transaction rolled back)
      const results = await users.query().where('email', '=', uniqueEmail).execute()

      expect(results.length).toBe(0)
      // No cleanup needed - transaction was rolled back
    })
  })

  describe('Nested Transaction Behavior', () => {
    test('should handle transaction within transaction', async () => {
      const createdIds: number[] = []

      // Note: Bun SQL may not support true nested transactions,
      // but we test the behavior
      await users.transaction(async (txUsers) => {
        const outer = await txUsers.create({
          name: 'Outer User',
          email: testData.user.valid().email,
        })

        createdIds.push(outer.id)

        // This may use the same transaction context
        await orm.transaction(async (tx) => {
          const innerUsers = users.withTransaction(tx)

          const inner = await innerUsers.create({
            name: 'Inner User',
            email: testData.user.valid().email,
          })

          createdIds.push(inner.id)
        })
      })

      const found = await users.query().whereIn('id', createdIds).execute()

      expect(found.length).toBeGreaterThanOrEqual(1)

      // Cleanup
      await users.deleteMany(createdIds)
    })
  })
})
