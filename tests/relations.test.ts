import type { InferEntity } from '../src/types'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getTestSchema, orm, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Relations', () => {
  beforeAll(async () => {
    await setupTestDatabase({ schema: getTestSchema(), autoMigrate: false })
  })

  afterAll(async () => {
    await teardownTestDatabase({ schema: getTestSchema() })
  })

  beforeEach(async () => {
    const db = orm.getDB()

    await db`DROP TABLE IF EXISTS test_post_tags CASCADE`
    await db`DROP TABLE IF EXISTS test_tags CASCADE`
    await db`DROP TABLE IF EXISTS test_comments CASCADE`
    await db`DROP TABLE IF EXISTS test_posts CASCADE`
    await db`DROP TABLE IF EXISTS test_profiles CASCADE`
    await db`DROP TABLE IF EXISTS test_users CASCADE`
  })

  describe('hasMany', () => {
    test('should load hasMany relation with correct types', async () => {
      const db = orm.getDB()

      await db`
        CREATE TABLE test_users (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        )
      `

      await db`
        CREATE TABLE test_posts (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          author_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE
        )
      `

      orm.entity('test_users', {
        name: orm.string(),
      }).build()

      const Post = orm.entity('test_posts', {
        title: orm.string(),
        authorId: orm.foreignKey('test_users').onDelete('CASCADE'),
      }).build()

      const UserWithPosts = orm.entity('test_users', {
        name: orm.string(),
      }).relations({
        posts: orm.hasMany<typeof Post>('test_posts', 'authorId'),
      }).build()

      const users = orm.repo(UserWithPosts)
      const posts = orm.repo(Post)

      const user = await users.create({ name: 'Alice' })

      await posts.create({ title: 'Post 1', authorId: user.id })
      await posts.create({ title: 'Post 2', authorId: user.id })
      await posts.create({ title: 'Post 3', authorId: user.id })

      const loaded = await users.find(user.id, { with: ['posts'] })

      expect(loaded).toBeDefined()
      expect(loaded!.posts).toBeDefined()
      expect(loaded!.posts).toBeArray()
      expect(loaded!.posts).toHaveLength(3)
      expect(loaded!.posts[0]!.title).toBe('Post 1')
      expect(loaded!.posts[1]!.title).toBe('Post 2')
      expect(loaded!.posts[2]!.title).toBe('Post 3')

      if (loaded) {
        type PostsType = typeof loaded.posts
        type ExpectedType = InferEntity<typeof Post.schema, typeof Post.traits>[]
        const _typeCheck: PostsType extends ExpectedType ? true : false = true

        expect(_typeCheck).toBe(true)
      }
    })

    test('should return empty array when no related records', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE)`

      orm.entity('test_users', {
        name: orm.string(),
      }).build()

      const Post = orm.entity('test_posts', {
        title: orm.string(),
        authorId: orm.foreignKey('test_users').onDelete('CASCADE'),
      }).build()

      const UserWithPosts = orm.entity('test_users', {
        name: orm.string(),
      }).relations({
        posts: orm.hasMany<typeof Post>('test_posts', 'authorId'),
      }).build()

      const users = orm.repo(UserWithPosts)

      orm.repo(Post)

      const user = await users.create({ name: 'Alice' })
      const loaded = await users.find(user.id, { with: ['posts'] })

      expect(loaded).toBeDefined()
      expect(loaded!.posts).toBeDefined()
      expect(loaded!.posts).toBeArray()
      expect(loaded!.posts).toHaveLength(0)
    })

    test('should batch load hasMany for multiple entities', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE)`

      orm.entity('test_users', {
        name: orm.string(),
      }).build()

      const Post = orm.entity('test_posts', {
        title: orm.string(),
        authorId: orm.foreignKey('test_users').onDelete('CASCADE'),
      }).build()

      const UserWithPosts = orm.entity('test_users', {
        name: orm.string(),
      }).relations({
        posts: orm.hasMany<typeof Post>('test_posts', 'authorId'),
      }).build()

      const users = orm.repo(UserWithPosts)
      const posts = orm.repo(Post)

      const user1 = await users.create({ name: 'Alice' })
      const user2 = await users.create({ name: 'Bob' })
      const _user3 = await users.create({ name: 'Charlie' })

      await posts.create({ title: 'Alice Post 1', authorId: user1.id })
      await posts.create({ title: 'Alice Post 2', authorId: user1.id })
      await posts.create({ title: 'Bob Post 1', authorId: user2.id })

      const loaded = await users.findAll({ with: ['posts'] })

      expect(loaded).toHaveLength(3)
      expect(loaded[0]!.posts).toHaveLength(2)
      expect(loaded[1]!.posts).toHaveLength(1)
      expect(loaded[2]!.posts).toHaveLength(0)
    })
  })

  describe('belongsTo', () => {
    test('should load belongsTo relation with correct types', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE)`

      const User = orm.entity('test_users', {
        name: orm.string(),
      }).build()

      const PostWithAuthor = orm.entity('test_posts', {
        title: orm.string(),
        authorId: orm.foreignKey('test_users').onDelete('CASCADE'),
      }).relations({
        author: orm.belongsTo<typeof User>('test_users', 'authorId'),
      }).build()

      const users = orm.repo(User)
      const posts = orm.repo(PostWithAuthor)

      const user = await users.create({ name: 'Alice' })
      const post = await posts.create({ title: 'Post 1', authorId: user.id })

      const loaded = await posts.find(post.id, { with: ['author'] })

      expect(loaded).toBeDefined()
      expect(loaded!.author).toBeDefined()
      expect(loaded?.author?.name).toBe('Alice')
      expect(loaded?.author?.id).toBe(user.id)

      if (loaded) {
        type AuthorType = typeof loaded.author
        type ExpectedType = InferEntity<typeof User.schema, typeof User.traits> | null
        const _typeCheck: AuthorType extends ExpectedType ? true : false = true

        expect(_typeCheck).toBe(true)
      }
    })

    test('should batch load belongsTo for multiple entities', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE)`

      const User = orm.entity('test_users', {
        name: orm.string(),
      }).build()

      const PostWithAuthor = orm.entity('test_posts', {
        title: orm.string(),
        authorId: orm.foreignKey('test_users').onDelete('CASCADE'),
      }).relations({
        author: orm.belongsTo<typeof User>('test_users', 'authorId'),
      }).build()

      const users = orm.repo(User)
      const posts = orm.repo(PostWithAuthor)

      const user1 = await users.create({ name: 'Alice' })
      const user2 = await users.create({ name: 'Bob' })

      await posts.create({ title: 'Post 1', authorId: user1.id })
      await posts.create({ title: 'Post 2', authorId: user2.id })
      await posts.create({ title: 'Post 3', authorId: user1.id })

      const loaded = await posts.findAll({ with: ['author'] })

      expect(loaded).toHaveLength(3)
      expect(loaded[0]?.author?.name).toBe('Alice')
      expect(loaded[1]?.author?.name).toBe('Bob')
      expect(loaded[2]?.author?.name).toBe('Alice')
    })
  })

  describe('hasOne', () => {
    test('should load hasOne relation with correct types', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_profiles (id SERIAL PRIMARY KEY, bio TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE)`

      const Profile = orm.entity('test_profiles', {
        bio: orm.string(),
        userId: orm.foreignKey('test_users').onDelete('CASCADE'),
      }).build()

      const UserWithProfile = orm.entity('test_users', {
        name: orm.string(),
      }).relations({
        profile: orm.hasOne<typeof Profile>('test_profiles', 'userId'),
      }).build()

      const users = orm.repo(UserWithProfile)
      const profiles = orm.repo(Profile)

      const user = await users.create({ name: 'Alice' })

      await profiles.create({ bio: 'Software Developer', userId: user.id })

      const loaded = await users.find(user.id, { with: ['profile'] })

      expect(loaded).toBeDefined()
      expect(loaded!.profile).toBeDefined()
      expect(loaded?.profile?.bio).toBe('Software Developer')

      if (loaded) {
        type ProfileType = typeof loaded.profile
        type ExpectedType = InferEntity<typeof Profile.schema, typeof Profile.traits> | null
        const _typeCheck: ProfileType extends ExpectedType ? true : false = true

        expect(_typeCheck).toBe(true)
      }
    })

    test('should return null when no related record', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_profiles (id SERIAL PRIMARY KEY, bio TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE)`

      const Profile = orm.entity('test_profiles', {
        bio: orm.string(),
        userId: orm.foreignKey('test_users').onDelete('CASCADE'),
      }).build()

      const UserWithProfile = orm.entity('test_users', {
        name: orm.string(),
      }).relations({
        profile: orm.hasOne<typeof Profile>('test_profiles', 'userId'),
      }).build()

      const users = orm.repo(UserWithProfile)

      orm.repo(Profile)

      const user = await users.create({ name: 'Alice' })
      const loaded = await users.find(user.id, { with: ['profile'] })

      expect(loaded).toBeDefined()
      expect(loaded!.profile).toBeNull()
    })
  })

  describe('manyToMany', () => {
    test('should load manyToMany relation with correct types', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL)`
      await db`CREATE TABLE test_tags (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_post_tags (post_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (post_id, tag_id))`

      const Tag = orm.entity('test_tags', {
        name: orm.string(),
      }).build()

      const PostWithTags = orm.entity('test_posts', {
        title: orm.string(),
      }).relations({
        tags: orm.manyToMany<typeof Tag>('test_tags', 'test_post_tags', 'postId', 'tagId'),
      }).build()

      const posts = orm.repo(PostWithTags)
      const tags = orm.repo(Tag)

      const post = await posts.create({ title: 'My Post' })
      const tag1 = await tags.create({ name: 'TypeScript' })
      const tag2 = await tags.create({ name: 'Bun' })
      const tag3 = await tags.create({ name: 'ORM' })

      await db`INSERT INTO test_post_tags (post_id, tag_id) VALUES (${post.id}, ${tag1.id})`
      await db`INSERT INTO test_post_tags (post_id, tag_id) VALUES (${post.id}, ${tag2.id})`
      await db`INSERT INTO test_post_tags (post_id, tag_id) VALUES (${post.id}, ${tag3.id})`

      const loaded = await posts.find(post.id, { with: ['tags'] })

      expect(loaded).toBeDefined()
      expect(loaded!.tags).toBeDefined()
      expect(loaded!.tags).toBeArray()
      expect(loaded!.tags).toHaveLength(3)
      expect(loaded?.tags?.map((t: any) => t.name).sort()).toEqual(['Bun', 'ORM', 'TypeScript'])

      if (loaded) {
        type TagsType = typeof loaded.tags
        type ExpectedType = InferEntity<typeof Tag.schema, typeof Tag.traits>[]
        const _typeCheck: TagsType extends ExpectedType ? true : false = true

        expect(_typeCheck).toBe(true)
      }
    })

    test('should return empty array when no related records', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL)`
      await db`CREATE TABLE test_tags (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_post_tags (post_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (post_id, tag_id))`

      const Tag = orm.entity('test_tags', {
        name: orm.string(),
      }).build()

      const PostWithTags = orm.entity('test_posts', {
        title: orm.string(),
      }).relations({
        tags: orm.manyToMany<typeof Tag>('test_tags', 'test_post_tags', 'postId', 'tagId'),
      }).build()

      const posts = orm.repo(PostWithTags)

      orm.repo(Tag)

      const post = await posts.create({ title: 'My Post' })
      const loaded = await posts.find(post.id, { with: ['tags'] })

      expect(loaded).toBeDefined()
      expect(loaded!.tags).toBeDefined()
      expect(loaded!.tags).toBeArray()
      expect(loaded!.tags).toHaveLength(0)
    })
  })

  describe('Multiple relations', () => {
    test('should load multiple relations at once', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE)`
      await db`CREATE TABLE test_profiles (id SERIAL PRIMARY KEY, bio TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE)`

      const Post = orm.entity('test_posts', {
        title: orm.string(),
        authorId: orm.foreignKey('test_users').onDelete('CASCADE'),
      }).build()

      const Profile = orm.entity('test_profiles', {
        bio: orm.string(),
        userId: orm.foreignKey('test_users').onDelete('CASCADE'),
      }).build()

      const UserWithRelations = orm.entity('test_users', {
        name: orm.string(),
      }).relations({
        posts: orm.hasMany<typeof Post>('test_posts', 'authorId'),
        profile: orm.hasOne<typeof Profile>('test_profiles', 'userId'),
      }).build()

      const users = orm.repo(UserWithRelations)
      const posts = orm.repo(Post)
      const profiles = orm.repo(Profile)

      const user = await users.create({ name: 'Alice' })

      await posts.create({ title: 'Post 1', authorId: user.id })
      await posts.create({ title: 'Post 2', authorId: user.id })
      await profiles.create({ bio: 'Developer', userId: user.id })

      const loaded = await users.find(user.id, { with: ['posts', 'profile'] })

      expect(loaded).toBeDefined()
      expect(loaded!.posts).toHaveLength(2)
      expect(loaded!.profile).toBeDefined()
      expect(loaded?.profile?.bio).toBe('Developer')
    })
  })

  describe('Error handling', () => {
    test('should throw error for non-existent relation', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`

      const User = orm.entity('test_users', {
        name: orm.string(),
      }).build()

      const users = orm.repo(User)
      const user = await users.create({ name: 'Alice' })

      await expect(async () => {
        // @ts-expect-error - Testing runtime validation for non-existent relation
        await users.find(user.id, { with: ['nonExistent'] })
      }).toThrow()
    })

    test('should throw error when related entity not registered', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`

      const User = orm.entity('test_users', {
        name: orm.string(),
      }).relations({
        posts: orm.hasMany('non_existent_table', 'authorId'),
      }).build()

      const users = orm.repo(User)
      const user = await users.create({ name: 'Alice' })

      await expect(async () => {
        await users.find(user.id, { with: ['posts'] })
      }).toThrow('Entity "non_existent_table" not registered in this ORM instance')
    })
  })

  describe('Without eager loading', () => {
    test('should work without with option', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE)`

      const Post = orm.entity('test_posts', {
        title: orm.string(),
        authorId: orm.foreignKey('test_users').onDelete('CASCADE'),
      }).build()

      const UserWithPosts = orm.entity('test_users', {
        name: orm.string(),
      }).relations({
        posts: orm.hasMany<typeof Post>('test_posts', 'authorId'),
      }).build()

      const users = orm.repo(UserWithPosts)
      const posts = orm.repo(Post)

      const user = await users.create({ name: 'Alice' })

      await posts.create({ title: 'Post 1', authorId: user.id })

      const loaded = await users.find(user.id)

      expect(loaded).toBeDefined()
      expect(loaded!.name).toBe('Alice')
      expect('posts' in loaded!).toBe(false)
    })
  })

  describe('Security', () => {
    test('should reject SQL injection in hasMany table name', () => {
      expect(() => {
        orm.hasMany('posts; DROP TABLE users; --', 'userId')
      }).toThrow()
    })

    test('should reject SQL injection in hasMany foreign key', () => {
      expect(() => {
        orm.hasMany('posts', 'userId; DELETE FROM posts; --')
      }).toThrow()
    })

    test('should reject SQL injection in belongsTo table name', () => {
      expect(() => {
        orm.belongsTo('users; DROP TABLE posts; --', 'authorId')
      }).toThrow()
    })

    test('should reject SQL injection in belongsTo foreign key', () => {
      expect(() => {
        orm.belongsTo('users', 'authorId; DELETE FROM users; --')
      }).toThrow()
    })

    test('should reject SQL injection in belongsTo owner key', () => {
      expect(() => {
        orm.belongsTo('users', 'authorId').owner('id; DROP TABLE users; --')
      }).toThrow()
    })

    test('should reject SQL injection in manyToMany table name', () => {
      expect(() => {
        orm.manyToMany('tags; DROP TABLE posts; --', 'post_tags', 'postId', 'tagId')
      }).toThrow()
    })

    test('should reject SQL injection in manyToMany junction table', () => {
      expect(() => {
        orm.manyToMany('tags', 'post_tags; DROP TABLE users; --', 'postId', 'tagId')
      }).toThrow()
    })

    test('should reject SQL injection in manyToMany throughForeignKey', () => {
      expect(() => {
        orm.manyToMany('tags', 'post_tags', 'postId; DELETE FROM posts; --', 'tagId')
      }).toThrow()
    })

    test('should reject SQL injection in manyToMany otherKey', () => {
      expect(() => {
        orm.manyToMany('tags', 'post_tags', 'postId', 'tagId; DELETE FROM tags; --')
      }).toThrow()
    })

    test('should reject SQL comment sequences in table names', () => {
      expect(() => {
        orm.hasMany('posts /* comment */', 'userId')
      }).toThrow()
    })

    test('should reject table names with spaces', () => {
      expect(() => {
        orm.hasMany('my table', 'userId')
      }).toThrow()
    })

    test('should reject table names with hyphens', () => {
      expect(() => {
        orm.hasMany('my-table', 'userId')
      }).toThrow()
    })
  })

  describe('Build-time validation', () => {
    beforeEach(async () => {
      const db = orm.getDB()

      await db`DROP TABLE IF EXISTS test_validation_posts CASCADE`
      await db`DROP TABLE IF EXISTS test_validation_users CASCADE`
    })

    test('should reject relation name that conflicts with field', () => {
      expect(() => {
        orm.entity('test_validation_users', {
          posts: orm.string(),
        }).relations({
          posts: orm.hasMany('test_validation_posts', 'userId'),
        }).build()
      }).toThrow('Relation name "posts" conflicts with existing field')
    })

    test('should reject belongsTo with non-existent foreign key field', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_validation_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`

      const _User = orm.entity('test_validation_users', {
        name: orm.string(),
      }).build()

      expect(() => {
        orm.entity('test_validation_posts', {
          title: orm.string(),
        }).relations({
          author: orm.belongsTo<typeof _User>('test_users', 'authorId'),
        }).build()
      }).toThrow('Foreign key "authorId" not found in schema')
    })

    test('should accept valid belongsTo with existing foreign key', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_validation_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`

      const _User = orm.entity('test_validation_users', {
        name: orm.string(),
      }).build()

      expect(() => {
        orm.entity('test_validation_posts', {
          title: orm.string(),
          authorId: orm.foreignKey('test_validation_users'),
        }).relations({
          author: orm.belongsTo<typeof _User>('test_users', 'authorId'),
        }).build()
      }).not.toThrow()
    })
  })

  describe('Edge cases', () => {
    beforeEach(async () => {
      const db = orm.getDB()

      await db`DROP TABLE IF EXISTS test_edge_profiles CASCADE`
      await db`DROP TABLE IF EXISTS test_edge_posts CASCADE`
      await db`DROP TABLE IF EXISTS test_edge_users CASCADE`
    })

    test('should handle empty with array', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_edge_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_edge_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES test_edge_users(id) ON DELETE CASCADE)`

      const _Post = orm.entity('test_edge_posts', {
        title: orm.string(),
        authorId: orm.foreignKey('test_edge_users').onDelete('CASCADE'),
      }).build()

      const UserWithPosts = orm.entity('test_edge_users', {
        name: orm.string(),
      }).relations({
        posts: orm.hasMany<typeof _Post>('test_edge_posts', 'authorId'),
      }).build()

      const users = orm.repo(UserWithPosts)

      const user = await users.create({ name: 'Alice' })

      const loaded = await users.find(user.id, { with: [] })

      expect(loaded).toBeDefined()
      expect('posts' in loaded!).toBe(false)
    })

    test('should handle null foreign keys in belongsTo', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_edge_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_edge_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER)`

      const _User = orm.entity('test_edge_users', {
        name: orm.string(),
      }).build()

      const Post = orm.entity('test_edge_posts', {
        title: orm.string(),
        authorId: orm.number().nullable(),
      }).relations({
        author: orm.belongsTo<typeof _User>('test_users', 'authorId'),
      }).build()

      const posts = orm.repo(Post)

      const post = await posts.create({ title: 'Orphan Post', authorId: null })
      const loaded = await posts.find(post.id, { with: ['author'] })

      expect(loaded?.author).toBeNull()
    })

    test('should take first record for hasOne with multiple matches', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_edge_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_edge_profiles (id SERIAL PRIMARY KEY, bio TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES test_edge_users(id) ON DELETE CASCADE)`

      const Profile = orm.entity('test_edge_profiles', {
        bio: orm.string(),
        userId: orm.foreignKey('test_edge_users').onDelete('CASCADE'),
      }).build()

      const UserWithProfile = orm.entity('test_edge_users', {
        name: orm.string(),
      }).relations({
        profile: orm.hasOne<typeof Profile>('test_edge_profiles', 'userId'),
      }).build()

      const users = orm.repo(UserWithProfile)
      const profiles = orm.repo(Profile)
      const user = await users.create({ name: 'Alice' })

      await profiles.create({ bio: 'First', userId: user.id })
      await profiles.create({ bio: 'Second', userId: user.id })

      const loaded = await users.find(user.id, { with: ['profile'] })

      expect(loaded?.profile).toBeDefined()
      expect(loaded?.profile?.bio).toBe('First')
    })

    test('should handle loading same relation multiple times', async () => {
      const db = orm.getDB()

      await db`CREATE TABLE test_edge_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
      await db`CREATE TABLE test_edge_posts (id SERIAL PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES test_edge_users(id) ON DELETE CASCADE)`

      const Post = orm.entity('test_edge_posts', {
        title: orm.string(),
        authorId: orm.foreignKey('test_edge_users').onDelete('CASCADE'),
      }).build()

      const UserWithPosts = orm.entity('test_edge_users', {
        name: orm.string(),
      }).relations({
        posts: orm.hasMany<typeof Post>('test_edge_posts', 'authorId'),
      }).build()

      const users = orm.repo(UserWithPosts)
      const posts = orm.repo(Post)
      const user = await users.create({ name: 'Alice' })

      await posts.create({ title: 'Post 1', authorId: user.id })

      const loaded1 = await users.find(user.id, { with: ['posts'] })
      const loaded2 = await users.find(user.id, { with: ['posts'] })

      expect(loaded1?.posts).toEqual(loaded2?.posts)
    })
  })
})
