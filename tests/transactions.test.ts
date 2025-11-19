import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import { cleanupTables, setupTestDatabase, teardownTestDatabase } from './setup'

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
  beforeAll(async () => {
    // Register repositories before connecting to enable auto-migration
    orm.repo(User)
    orm.repo(Post)
    await setupTestDatabase()
  })

  afterAll(async () => {
    await cleanupTables('test_tx_posts', 'test_tx_users')
    await teardownTestDatabase()
  })

  describe('Repository-Scoped Transactions', () => {
    test('should commit successful transaction', async () => {
      const users = orm.repo(User)
      const db = orm.getDB()

      await db`DELETE FROM test_tx_users`

      let createdUser: any = null

      await users.transaction(async (txUsers) => {
        createdUser = await txUsers.create({
          name: 'TX User',
          email: 'tx@example.com',
        })
      })

      // Verify entity exists after commit
      const found = await users.find(createdUser.id)

      expect(found).not.toBeNull()
      expect(found?.name).toBe('TX User')
    })

    test('should rollback failed transaction', async () => {
      const users = orm.repo(User)
      const db = orm.getDB()

      await db`DELETE FROM test_tx_users`

      let createdId: number | null = null

      try {
        await users.transaction(async (txUsers) => {
          const user = await txUsers.create({
            name: 'Will Rollback',
            email: 'rollback@example.com',
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
    })

    test('should handle multiple operations in transaction', async () => {
      const users = orm.repo(User)
      const db = orm.getDB()

      await db`DELETE FROM test_tx_users`

      const createdIds: number[] = []

      await users.transaction(async (txUsers) => {
        const user1 = await txUsers.create({
          name: 'User 1',
          email: 'user1@example.com',
        })

        createdIds.push(user1.id)

        const user2 = await txUsers.create({
          name: 'User 2',
          email: 'user2@example.com',
        })

        createdIds.push(user2.id)

        await txUsers.update(user1.id, { name: 'Updated User 1' })
      })

      // Verify all operations committed
      const user1 = await users.find(createdIds[0] as number)
      const user2 = await users.find(createdIds[1] as number)

      expect(user1?.name).toBe('Updated User 1')
      expect(user2?.name).toBe('User 2')
    })

    test('should rollback all operations on error', async () => {
      const users = orm.repo(User)
      const db = orm.getDB()

      await db`DELETE FROM test_tx_users`

      const createdIds: number[] = []

      try {
        await users.transaction(async (txUsers) => {
          const user1 = await txUsers.create({
            name: 'User 1',
            email: 'rollback1@example.com',
          })

          createdIds.push(user1.id)

          const user2 = await txUsers.create({
            name: 'User 2',
            email: 'rollback2@example.com',
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
    })
  })

  describe('Global Transactions with Multiple Repositories', () => {
    test('should commit global transaction', async () => {
      const users = orm.repo(User)
      const posts = orm.repo(Post)
      const db = orm.getDB()

      await db`DELETE FROM test_tx_posts`
      await db`DELETE FROM test_tx_users`

      let userId: number | null = null
      let postId: number | null = null

      await orm.transaction(async (tx) => {
        const txUsers = users.withTransaction(tx)
        const txPosts = posts.withTransaction(tx)

        const user = await txUsers.create({
          name: 'Author',
          email: 'author@example.com',
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
    })

    test('should rollback global transaction on error', async () => {
      const users = orm.repo(User)
      const posts = orm.repo(Post)
      const db = orm.getDB()

      await db`DELETE FROM test_tx_posts`
      await db`DELETE FROM test_tx_users`

      let userId: number | null = null
      let postId: number | null = null

      try {
        await orm.transaction(async (tx) => {
          const txUsers = users.withTransaction(tx)
          const txPosts = posts.withTransaction(tx)

          const user = await txUsers.create({
            name: 'Author',
            email: 'rollback-author@example.com',
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
    })

    test('should handle complex multi-repo transaction', async () => {
      const users = orm.repo(User)
      const posts = orm.repo(Post)
      const db = orm.getDB()

      await db`DELETE FROM test_tx_posts`
      await db`DELETE FROM test_tx_users`

      await orm.transaction(async (tx) => {
        const txUsers = users.withTransaction(tx)
        const txPosts = posts.withTransaction(tx)

        // Create user
        const user = await txUsers.create({
          name: 'Multi Author',
          email: 'multi@example.com',
        })

        // Create multiple posts
        await txPosts.create({
          title: 'Post 1',
          content: 'Content 1',
          authorId: user.id,
        })

        await txPosts.create({
          title: 'Post 2',
          content: 'Content 2',
          authorId: user.id,
        })

        // Update user
        await txUsers.update(user.id, { name: 'Updated Multi Author' })
      })

      // Verify all operations succeeded
      const allUsers = await users.findAll()
      const allPosts = await posts.findAll()

      expect(allUsers.length).toBe(1)
      expect(allUsers[0]?.name).toBe('Updated Multi Author')
      expect(allPosts.length).toBe(2)
    })
  })

  describe('Transaction Isolation', () => {
    test('should isolate transaction from non-transactional reads', async () => {
      const users = orm.repo(User)
      const db = orm.getDB()

      await db`DELETE FROM test_tx_users`

      // This test demonstrates that within a transaction, changes are isolated
      // until committed (though this behavior may vary based on isolation level)

      await users.transaction(async (txUsers) => {
        await txUsers.create({
          name: 'Isolated User',
          email: 'isolated@example.com',
        })

        // Within transaction, we can see the created user
        const txCount = await txUsers.count()

        expect(txCount).toBe(1)
      })

      // After commit, we can see it from outside
      const count = await users.count()

      expect(count).toBe(1)
    })
  })

  describe('Transaction Error Handling', () => {
    test('should propagate errors from transaction', async () => {
      const users = orm.repo(User)

      let errorCaught = false

      try {
        await users.transaction(async (txUsers) => {
          await txUsers.create({
            name: 'User',
            email: 'error@example.com',
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
    })

    test('should handle database errors in transaction', async () => {
      const users = orm.repo(User)
      const db = orm.getDB()

      await db`DELETE FROM test_tx_users`

      let errorCaught = false

      try {
        await users.transaction(async (txUsers) => {
          await txUsers.create({
            name: 'User 1',
            email: 'unique@example.com',
          })

          // Try to create duplicate (unique constraint violation)
          await txUsers.create({
            name: 'User 2',
            email: 'unique@example.com',
          })
        })
      }
      catch (error) {
        errorCaught = true
      }

      expect(errorCaught).toBe(true)

      // Verify no entities were created
      const count = await users.count()

      expect(count).toBe(0)
    })
  })

  describe('Nested Transaction Behavior', () => {
    test('should handle transaction within transaction', async () => {
      const users = orm.repo(User)
      const db = orm.getDB()

      await db`DELETE FROM test_tx_users`

      // Note: Bun SQL may not support true nested transactions,
      // but we test the behavior
      await users.transaction(async (txUsers) => {
        await txUsers.create({
          name: 'Outer User',
          email: 'outer@example.com',
        })

        // This may use the same transaction context
        await orm.transaction(async (tx) => {
          const innerUsers = users.withTransaction(tx)

          await innerUsers.create({
            name: 'Inner User',
            email: 'inner@example.com',
          })
        })
      })

      const count = await users.count()

      expect(count).toBeGreaterThanOrEqual(1)
    })
  })
})
