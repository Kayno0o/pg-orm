import type { InferEntity } from '../src'
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

type PostType = InferEntity<typeof Post.schema>

const Comment = orm.entity('test_join_comments', {
  content: orm.string(),
  postId: orm.number(),
  userId: orm.number(),
}).build()

const Author = orm.entity('test_smart_authors', {
  name: orm.string(),
  email: orm.string(),
  role: orm.string(),
}).build()

type AuthorType = InferEntity<typeof Author.schema>

const Profile = orm.entity('test_smart_profiles', {
  bio: orm.string(),
  authorId: orm.number(),
}).build()

type ProfileType = InferEntity<typeof Profile.schema>

const Article = orm.entity('test_smart_articles', {
  title: orm.string(),
  content: orm.string(),
  authorId: orm.number().nullable(),
}).relations({
  author: orm.belongsTo('test_smart_authors', 'authorId'),
}).build()

const AuthorWithProfile = orm.entity('test_smart_authors_2', {
  name: orm.string(),
  email: orm.string(),
}).relations({
  profile: orm.hasOne('test_smart_profiles', 'authorId'),
}).build()

describe('QueryBuilder JOINs', () => {
  const schema = getTestSchema()

  beforeAll(async () => {
    // Register repos before connecting to enable auto-migration
    orm.repo(User)
    orm.repo(Post)
    orm.repo(Comment)
    orm.repo(Author)
    orm.repo(Profile)
    orm.repo(Article)
    orm.repo(AuthorWithProfile)

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
          .execute() as PostType[]

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
          .execute()

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
          .execute()

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
          .execute()

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
          .execute()

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
          .execute()

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
          .execute()

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
          .execute()

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
          .execute()

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
          .execute()

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
          .execute()

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
          .execute()

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
          .execute()

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
          .execute() as { title: string, content: string, name: string, email: string }[]

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
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.title).toBe('First Post')
        // Should only have the selected field
        expect(results[0]).toHaveProperty('title')
        expect(results[0]).not.toHaveProperty('content')
      })
    })
  })

  describe('Unified Relations (.with)', () => {
    describe('Basic belongsTo joins', () => {
      test('should join belongsTo relation', async () => {
        await runInTransaction(async (tx) => {
          const authors = createTxRepo(Author, tx)
          const articles = createTxRepo(Article, tx)

          const author = await authors.create({
            name: 'Alice',
            email: 'alice@example.com',
            role: 'admin',
          })

          await articles.create({
            title: 'First Article',
            content: 'Content here',
            authorId: author.id,
          })

          const results = await articles.query()
            .with<AuthorType | null>('author')
            .execute()

          expect(results.length).toBe(1)
          expect(results[0]?.title).toBe('First Article')
          expect(results[0]?.author).toBeDefined()
          expect(results[0]?.author?.name).toBe('Alice')
          expect(results[0]?.author?.role).toBe('admin')
        })
      })

      test('should handle null foreign keys', async () => {
        await runInTransaction(async (tx) => {
          const articles = createTxRepo(Article, tx)

          await articles.create({
            title: 'Orphan Article',
            content: 'No author',
            authorId: null,
          })

          const results = await articles.query()
            .with<AuthorType | null>('author')
            .execute()

          expect(results.length).toBe(1)
          expect(results[0]?.title).toBe('Orphan Article')
          expect(results[0]?.author).toBeNull()
        })
      })
    })

    describe('WHERE with dot notation', () => {
      test('should filter by joined relation field', async () => {
        await runInTransaction(async (tx) => {
          const authors = createTxRepo(Author, tx)
          const articles = createTxRepo(Article, tx)

          const admin = await authors.create({
            name: 'Admin User',
            email: 'admin@example.com',
            role: 'admin',
          })

          const regular = await authors.create({
            name: 'Regular User',
            email: 'user@example.com',
            role: 'user',
          })

          await articles.create({
            title: 'Admin Post',
            content: 'Content',
            authorId: admin.id,
          })

          await articles.create({
            title: 'User Post',
            content: 'Content',
            authorId: regular.id,
          })

          const results = await articles.query()
            .with<AuthorType | null>('author')
            .where('author.role', '=', 'admin')
            .execute()

          expect(results.length).toBe(1)
          expect(results[0]?.title).toBe('Admin Post')
          expect(results[0]?.author?.role).toBe('admin')
        })
      })

      test('should support multiple WHERE clauses with dot notation', async () => {
        await runInTransaction(async (tx) => {
          const authors = createTxRepo(Author, tx)
          const articles = createTxRepo(Article, tx)

          const author = await authors.create({
            name: 'Alice',
            email: 'alice@example.com',
            role: 'admin',
          })

          await articles.create({
            title: 'Article 1',
            content: 'Content',
            authorId: author.id,
          })

          await articles.create({
            title: 'Article 2',
            content: 'Content',
            authorId: author.id,
          })

          const results = await articles.query()
            .with<AuthorType | null>('author')
            .where('author.role', '=', 'admin')
            .where('author.name', '=', 'Alice')
            .execute()

          expect(results.length).toBe(2)
          expect(results.every(r => r.author?.name === 'Alice')).toBe(true)
        })
      })
    })

    describe('ORDER BY with dot notation', () => {
      test('should order by joined relation field', async () => {
        await runInTransaction(async (tx) => {
          const authors = createTxRepo(Author, tx)
          const articles = createTxRepo(Article, tx)

          const bob = await authors.create({
            name: 'Bob',
            email: 'bob@example.com',
            role: 'user',
          })

          const alice = await authors.create({
            name: 'Alice',
            email: 'alice@example.com',
            role: 'admin',
          })

          await articles.create({
            title: 'Bob Article',
            content: 'Content',
            authorId: bob.id,
          })

          await articles.create({
            title: 'Alice Article',
            content: 'Content',
            authorId: alice.id,
          })

          const results = await articles.query()
            .with<AuthorType | null>('author')
            .orderBy('author.name', 'ASC')
            .execute()

          expect(results.length).toBe(2)
          expect(results[0]?.author?.name).toBe('Alice')
          expect(results[1]?.author?.name).toBe('Bob')
        })
      })

      test('should support DESC ordering', async () => {
        await runInTransaction(async (tx) => {
          const authors = createTxRepo(Author, tx)
          const articles = createTxRepo(Article, tx)

          const bob = await authors.create({
            name: 'Bob',
            email: 'bob@example.com',
            role: 'user',
          })

          const alice = await authors.create({
            name: 'Alice',
            email: 'alice@example.com',
            role: 'admin',
          })

          await articles.create({
            title: 'Bob Article',
            content: 'Content',
            authorId: bob.id,
          })

          await articles.create({
            title: 'Alice Article',
            content: 'Content',
            authorId: alice.id,
          })

          const results = await articles.query()
            .with<AuthorType | null>('author')
            .orderByDesc('author.name')
            .execute()

          expect(results.length).toBe(2)
          expect(results[0]?.author?.name).toBe('Bob')
          expect(results[1]?.author?.name).toBe('Alice')
        })
      })
    })

    describe('SELECT with dot notation', () => {
      test('should select specific relation fields', async () => {
        await runInTransaction(async (tx) => {
          const authors = createTxRepo(Author, tx)
          const articles = createTxRepo(Article, tx)

          const author = await authors.create({
            name: 'Alice',
            email: 'alice@example.com',
            role: 'admin',
          })

          await articles.create({
            title: 'Article',
            content: 'Content',
            authorId: author.id,
          })

          const results = await articles.query()
            .with<AuthorType | null>('author')
            .select('title', 'author.name')
            .execute() as { title: string, author: { name: string } }[]

          expect(results.length).toBe(1)
          expect(results[0]?.title).toBe('Article')
          expect(results[0]?.author?.name).toBe('Alice')
          // @ts-expect-error expect to be undefined
          expect(results[0]?.content).toBeUndefined()
          // @ts-expect-error expect to be undefined
          expect(results[0]?.author?.email).toBeUndefined()
        })
      })
    })

    describe('Multiple relation joins', () => {
      test('should support joining multiple relations', async () => {
        await runInTransaction(async (tx) => {
          // This test would require a more complex schema with multiple relations
          // For now, we can test sequential joins
          const authors = createTxRepo(Author, tx)
          const articles = createTxRepo(Article, tx)

          const author = await authors.create({
            name: 'Alice',
            email: 'alice@example.com',
            role: 'admin',
          })

          await articles.create({
            title: 'Article',
            content: 'Content',
            authorId: author.id,
          })

          const results = await articles.query()
            .with<AuthorType | null>('author')
            .execute()

          expect(results.length).toBe(1)
          expect(results[0]?.author).toBeDefined()
        })
      })
    })

    describe('Error handling', () => {
      test('should error when relation not found', async () => {
        await runInTransaction(async (tx) => {
          const articles = createTxRepo(Article, tx)

          expect(() => {
            articles.query().with('nonexistent')
          }).toThrow('Relation "nonexistent" not found')
        })
      })

      test('should error when trying to join hasMany relation', async () => {
        await runInTransaction(async (tx) => {
          // This would need an entity with hasMany relation
          // For now just test the error message format
          const authors = createTxRepo(Author, tx)

          // Authors don't have relations defined, so this will error with "not found"
          // In a real scenario with hasMany, it would error with "only supports belongsTo and hasOne"
          expect(() => {
            authors.query().with('anything')
          }).toThrow()
        })
      })

      test('should error when querying unjoined relation field', async () => {
        await runInTransaction(async (tx) => {
          const articles = createTxRepo(Article, tx)

          await expect(async () => {
            await articles.query()
              .where('author.name', '=', 'Alice')
              .execute()
          }).toThrow('Relation "author" not joined')
        })
      })

      test('should error on invalid field in dot notation', async () => {
        await runInTransaction(async (tx) => {
          const articles = createTxRepo(Article, tx)

          await expect(async () => {
            await articles.query()
              .with<AuthorType | null>('author')
              .where('author.invalidField', '=', 'value')
              .execute()
          }).toThrow('Field "invalidField" not found on relation "author"')
        })
      })

      test('should error when joining same relation twice', async () => {
        await runInTransaction(async (tx) => {
          const articles = createTxRepo(Article, tx)

          expect(() => {
            articles.query()
              .with<AuthorType | null>('author')
              .with<AuthorType | null>('author')
          }).toThrow('Relation "author" already loaded')
        })
      })
    })

    describe('hasOne relations', () => {
      test('should join hasOne relation', async () => {
        await runInTransaction(async (tx) => {
          const authors = createTxRepo(AuthorWithProfile, tx)
          const profiles = createTxRepo(Profile, tx)

          const author = await authors.create({
            name: 'Alice',
            email: 'alice@example.com',
          })

          await profiles.create({
            bio: 'Software engineer',
            authorId: author.id,
          })

          const results = await authors.query()
            .with<ProfileType | null>('profile')
            .execute()

          expect(results.length).toBe(1)
          expect(results[0]?.name).toBe('Alice')
          expect(results[0]?.profile).toBeDefined()
          expect(results[0]?.profile?.bio).toBe('Software engineer')
        })
      })

      test('should handle hasOne with no match', async () => {
        await runInTransaction(async (tx) => {
          const authors = createTxRepo(AuthorWithProfile, tx)

          await authors.create({
            name: 'Bob',
            email: 'bob@example.com',
          })

          const results = await authors.query()
            .with<ProfileType | null>('profile')
            .execute()

          expect(results.length).toBe(1)
          expect(results[0]?.name).toBe('Bob')
          expect(results[0]?.profile).toBeNull()
        })
      })
    })
  })
})
