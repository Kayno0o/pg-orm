import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTxRepo, getTestSchema, orm, runInTransaction, setupTestDatabase, teardownTestDatabase } from './setup'

const User = orm.entity('test_join_users', {
  name: orm.string(),
  email: orm.string(),
}).build()

const Post = orm.entity('test_join_posts', {
  title: orm.string(),
  content: orm.string(),
  userId: orm.number(),
}).build()

const Comment = orm.entity('test_join_comments', {
  content: orm.string(),
  postId: orm.number(),
  userId: orm.number(),
}).build()

describe('QueryBuilder JOINs', () => {
  const schema = getTestSchema()

  beforeAll(async () => {
    // Register repos before connecting to enable auto-migration
    orm.repo(User)
    orm.repo(Post)
    orm.repo(Comment)

    await setupTestDatabase({ schema })
  })

  afterAll(async () => {
    await teardownTestDatabase({ schema })
  })

  describe('INNER JOIN', () => {
    test('should perform basic inner join', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await posts.create({
          title: 'First Post',
          content: 'Content here',
          userId: user.id,
        })

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .where('title', '=', 'First Post')
          .execute() as any[]

        expect(results.length).toBe(1)
        expect(results[0]?.title).toBe('First Post')
      })
    })

    test('should filter joined data with where clause', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const alice = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        const bob = await users.create({
          name: 'Bob',
          email: 'bob@example.com',
        })

        await posts.create({
          title: 'Alice Post',
          content: 'Content',
          userId: alice.id,
        })

        await posts.create({
          title: 'Bob Post',
          content: 'Content',
          userId: bob.id,
        })

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .where('userId', '=', alice.id)
          .execute() as any[]

        expect(results.length).toBe(1)
        expect(results[0]?.title).toBe('Alice Post')
      })
    })

    test('should combine join with order by', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await posts.create({
          title: 'Z Post',
          content: 'Content',
          userId: user.id,
        })

        await posts.create({
          title: 'A Post',
          content: 'Content',
          userId: user.id,
        })

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .orderBy('title', 'ASC')
          .execute() as any[]

        expect(results.length).toBe(2)
        expect(results[0]?.title).toBe('A Post')
        expect(results[1]?.title).toBe('Z Post')
      })
    })
  })

  describe('LEFT JOIN', () => {
    test('should include rows with no matching join', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const alice = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await users.create({
          name: 'Bob',
          email: 'bob@example.com',
        })

        await posts.create({
          title: 'Alice Post',
          content: 'Content',
          userId: alice.id,
        })

        const results = await users.query()
          .leftJoin('test_join_posts', 'test_join_users.id', '=', 'test_join_posts.user_id')
          .execute() as any[]

        expect(results.length).toBe(2)
      })
    })

    test('should handle null values in left join', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({
          name: 'Bob',
          email: 'bob@example.com',
        })

        const results = await users.query()
          .leftJoin('test_join_posts', 'test_join_users.id', '=', 'test_join_posts.user_id')
          .where('name', '=', 'Bob')
          .execute() as any[]

        expect(results.length).toBeGreaterThanOrEqual(1)
      })
    })
  })

  describe('RIGHT JOIN', () => {
    test('should perform right join', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await posts.create({
          title: 'Post',
          content: 'Content',
          userId: user.id,
        })

        const results = await posts.query()
          .rightJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .execute() as any[]

        expect(results.length).toBeGreaterThanOrEqual(1)
      })
    })
  })

  describe('FULL JOIN', () => {
    test('should perform full outer join', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await posts.create({
          title: 'Post',
          content: 'Content',
          userId: user.id,
        })

        const results = await posts.query()
          .fullJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .execute() as any[]

        expect(results.length).toBeGreaterThanOrEqual(1)
      })
    })
  })

  describe('Multiple JOINs', () => {
    test('should handle multiple join clauses', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)
        const comments = createTxRepo(Comment, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        const post = await posts.create({
          title: 'Post Title',
          content: 'Post Content',
          userId: user.id,
        })

        await comments.create({
          content: 'My Comment',
          postId: post.id,
          userId: user.id,
        })

        const results = await comments.query()
          .innerJoin('test_join_posts', 'test_join_comments.post_id', '=', 'test_join_posts.id')
          .innerJoin('test_join_users', 'test_join_comments.user_id', '=', 'test_join_users.id')
          .where('postId', '=', post.id)
          .execute() as any[]

        expect(results.length).toBe(1)
      })
    })
  })

  describe('JOIN with different operators', () => {
    test('should support != operator', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await posts.create({
          title: 'Post',
          content: 'Content',
          userId: user.id,
        })

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '!=', 'test_join_users.id')
          .execute() as any[]

        expect(Array.isArray(results)).toBe(true)
      })
    })

    test('should support > operator', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await posts.create({
          title: 'Post',
          content: 'Content',
          userId: user.id,
        })

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.id', '>', 'test_join_users.id')
          .execute() as any[]

        expect(Array.isArray(results)).toBe(true)
      })
    })

    test('should reject invalid operators', async () => {
      await runInTransaction(async (tx) => {
        const posts = createTxRepo(Post, tx)

        expect(() => {
          posts.query()
            .innerJoin('test_join_users', 'test_join_posts.user_id', 'INVALID', 'test_join_users.id')
        }).toThrow('Invalid JOIN operator')
      })
    })
  })

  describe('JOIN with LIMIT and OFFSET', () => {
    test('should limit joined results', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        for (let i = 0; i < 5; i++) {
          await posts.create({
            title: `Post ${i}`,
            content: 'Content',
            userId: user.id,
          })
        }

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .limit(3)
          .execute() as any[]

        expect(results.length).toBe(3)
      })
    })

    test('should offset joined results', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        for (let i = 0; i < 5; i++) {
          await posts.create({
            title: `Post ${i}`,
            content: 'Content',
            userId: user.id,
          })
        }

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .orderBy('title', 'ASC')
          .offset(2)
          .limit(2)
          .execute() as any[]

        expect(results.length).toBe(2)
      })
    })
  })

  describe('JOIN edge cases', () => {
    test('should handle join with no results', async () => {
      await runInTransaction(async (tx) => {
        const posts = createTxRepo(Post, tx)

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .where('title', '=', 'NonExistent')
          .execute() as any[]

        expect(results.length).toBe(0)
      })
    })

    test('should validate table names in joins', async () => {
      await runInTransaction(async (tx) => {
        const posts = createTxRepo(Post, tx)

        expect(() => {
          posts.query()
            .innerJoin('invalid;table', 'test_join_posts.user_id', '=', 'invalid;table.id')
        }).toThrow()
      })
    })
  })

  describe('JOIN with findOne', () => {
    test('should return single result with join', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await posts.create({
          title: 'Post',
          content: 'Content',
          userId: user.id,
        })

        const result = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .findOne()

        expect(result).not.toBeNull()
        expect(result?.title).toBe('Post')
      })
    })
  })

  describe('JOIN query building', () => {
    test('should build correct SQL for inner join', async () => {
      await runInTransaction(async (tx) => {
        const posts = createTxRepo(Post, tx)

        const { sql } = posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .build()

        expect(sql).toContain('INNER JOIN')
        expect(sql).toContain('test_join_users')
        expect(sql).toContain('test_join_posts.user_id = test_join_users.id')
      })
    })

    test('should build correct SQL for left join', async () => {
      await runInTransaction(async (tx) => {
        const posts = createTxRepo(Post, tx)

        const { sql } = posts.query()
          .leftJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .build()

        expect(sql).toContain('LEFT JOIN')
        expect(sql).toContain('test_join_users')
      })
    })

    test('should build correct SQL for multiple joins', async () => {
      await runInTransaction(async (tx) => {
        const comments = createTxRepo(Comment, tx)

        const { sql } = comments.query()
          .innerJoin('test_join_posts', 'test_join_comments.post_id', '=', 'test_join_posts.id')
          .innerJoin('test_join_users', 'test_join_comments.user_id', '=', 'test_join_users.id')
          .build()

        expect(sql).toContain('INNER JOIN test_join_posts')
        expect(sql).toContain('INNER JOIN test_join_users')
      })
    })

    test('should default to selecting tableName.* for joins', async () => {
      await runInTransaction(async (tx) => {
        const posts = createTxRepo(Post, tx)

        const { sql } = posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .build()

        expect(sql).toContain('SELECT test_join_posts.*')
      })
    })
  })

  describe('JOIN result mapping', () => {
    test('should return mapped entities by default (without custom select)', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await posts.create({
          title: 'First Post',
          content: 'Content here',
          userId: user.id,
        })

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.title).toBe('First Post')
        expect(results[0]?.content).toBe('Content here')
        expect(results[0]?.userId).toBe(user.id)
        // Should only have Post fields, not User fields (since we're selecting test_join_posts.*)
        expect(results[0]).toHaveProperty('title')
        expect(results[0]).toHaveProperty('content')
        expect(results[0]).toHaveProperty('userId')
        // Should NOT have user's name or email from the joined table
        expect(results[0]).not.toHaveProperty('name')
        expect(results[0]).not.toHaveProperty('email')
      })
    })

    test('should return raw objects with custom cross-table select', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await posts.create({
          title: 'First Post',
          content: 'Content here',
          userId: user.id,
        })

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .select('test_join_posts.title', 'test_join_posts.content', 'test_join_users.name', 'test_join_users.email')
          .execute() as any[]

        expect(results.length).toBe(1)
        // Should have fields from both tables
        expect(results[0]?.title).toBe('First Post')
        expect(results[0]?.content).toBe('Content here')
        expect(results[0]?.name).toBe('Alice')
        expect(results[0]?.email).toBe('alice@example.com')
      })
    })

    test('should allow selecting specific fields from main table with joins', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)
        const posts = createTxRepo(Post, tx)

        const user = await users.create({
          name: 'Alice',
          email: 'alice@example.com',
        })

        await posts.create({
          title: 'First Post',
          content: 'Content here',
          userId: user.id,
        })

        const results = await posts.query()
          .innerJoin('test_join_users', 'test_join_posts.user_id', '=', 'test_join_users.id')
          .select('title')
          .execute() as any[]

        expect(results.length).toBe(1)
        expect(results[0]?.title).toBe('First Post')
        // Should only have the selected field
        expect(results[0]).toHaveProperty('title')
        expect(results[0]).not.toHaveProperty('content')
      })
    })
  })
})
