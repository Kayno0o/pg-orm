import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { belongsTo, hasMany, hasOne, orm } from '../src'
import { cleanupTables, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Relations', () => {
  // Entity definitions
  const User = orm.entity('test_rel_users', {
    name: orm.string(),
    email: orm.string().unique(),
  }).build()

  const Post = orm.entity('test_rel_posts', {
    title: orm.string(),
    content: orm.string(),
    authorId: orm.number(),
    published: orm.boolean().default(false),
  }).build()

  const Profile = orm.entity('test_rel_profiles', {
    userId: orm.number().unique(),
    bio: orm.string(),
    website: orm.string().nullable(),
  }).build()

  const Comment = orm.entity('test_rel_comments', {
    postId: orm.number(),
    userId: orm.number(),
    content: orm.string(),
  }).build()

  let users: ReturnType<typeof orm.repo<typeof User.schema>>
  let posts: ReturnType<typeof orm.repo<typeof Post.schema>>
  let profiles: ReturnType<typeof orm.repo<typeof Profile.schema>>
  let comments: ReturnType<typeof orm.repo<typeof Comment.schema>>

  beforeAll(async () => {
    users = orm.repo(User)
    posts = orm.repo(Post)
    profiles = orm.repo(Profile)
    comments = orm.repo(Comment)

    await setupTestDatabase()
  })

  afterAll(async () => {
    await cleanupTables('test_rel_comments', 'test_rel_posts', 'test_rel_profiles', 'test_rel_users')
    await teardownTestDatabase()
  })

  describe('belongsTo (Many-to-One)', () => {
    test('should load a single related entity', async () => {
      const user = await users.create({ name: 'John Doe', email: 'john@example.com' })
      const post = await posts.create({
        title: 'Test Post',
        content: 'Content here',
        authorId: user.id,
      })

      const postAuthor = belongsTo('authorId', users)
      const author = await postAuthor.load(post)

      expect(author).not.toBeNull()
      expect(author?.id).toBe(user.id)
      expect(author?.name).toBe('John Doe')
      expect(author?.email).toBe('john@example.com')
    })

    test('should return null for null foreign key', async () => {
      // Create a post without an author (if nullable was supported)
      await users.create({ name: 'Jane Doe', email: 'jane@example.com' })
      const post = await posts.create({
        title: 'Orphan Post',
        content: 'No author',
        authorId: 99999, // Non-existent author
      })

      const postAuthor = belongsTo('authorId', users)
      const author = await postAuthor.load(post)

      expect(author).toBeNull()
    })

    test('should batch load related entities (prevent N+1)', async () => {
      const user1 = await users.create({ name: 'Author 1', email: 'author1@example.com' })
      const user2 = await users.create({ name: 'Author 2', email: 'author2@example.com' })
      const user3 = await users.create({ name: 'Author 3', email: 'author3@example.com' })

      const post1 = await posts.create({ title: 'Post 1', content: 'Content 1', authorId: user1.id })
      const post2 = await posts.create({ title: 'Post 2', content: 'Content 2', authorId: user2.id })
      const post3 = await posts.create({ title: 'Post 3', content: 'Content 3', authorId: user1.id })
      const post4 = await posts.create({ title: 'Post 4', content: 'Content 4', authorId: user3.id })

      const allPosts = [post1, post2, post3, post4]

      const postAuthor = belongsTo('authorId', users)
      const authorsMap = await postAuthor.loadMany(allPosts)

      // Should batch load all unique authors
      expect(authorsMap.size).toBe(3)
      expect(authorsMap.get(user1.id)?.name).toBe('Author 1')
      expect(authorsMap.get(user2.id)?.name).toBe('Author 2')
      expect(authorsMap.get(user3.id)?.name).toBe('Author 3')

      // Verify mapping
      const author1 = authorsMap.get(post1.authorId)

      expect(author1?.id).toBe(user1.id)

      const author2 = authorsMap.get(post2.authorId)

      expect(author2?.id).toBe(user2.id)
    })

    test('should handle empty array in batch load', async () => {
      const postAuthor = belongsTo('authorId', users)
      const authorsMap = await postAuthor.loadMany([])

      expect(authorsMap.size).toBe(0)
    })
  })

  describe('hasMany (One-to-Many)', () => {
    test('should load all related entities', async () => {
      const user = await users.create({ name: 'Prolific Author', email: 'prolific@example.com' })

      await posts.create({ title: 'Post A', content: 'Content A', authorId: user.id })
      await posts.create({ title: 'Post B', content: 'Content B', authorId: user.id })
      await posts.create({ title: 'Post C', content: 'Content C', authorId: user.id })

      const userPosts = hasMany('authorId', posts)
      const authorPosts = await userPosts.load(user)

      expect(authorPosts.length).toBe(3)
      expect(authorPosts.every(p => p.authorId === user.id)).toBe(true)
      expect(authorPosts.map(p => p.title).sort()).toEqual(['Post A', 'Post B', 'Post C'])
    })

    test('should return empty array when no related entities', async () => {
      const user = await users.create({ name: 'No Posts User', email: 'noposts@example.com' })

      const userPosts = hasMany('authorId', posts)
      const authorPosts = await userPosts.load(user)

      expect(authorPosts).toEqual([])
    })

    test('should batch load related entities (prevent N+1)', async () => {
      const user1 = await users.create({ name: 'User 1', email: 'user1@batch.com' })
      const user2 = await users.create({ name: 'User 2', email: 'user2@batch.com' })
      const user3 = await users.create({ name: 'User 3', email: 'user3@batch.com' })

      await posts.create({ title: 'U1 Post 1', content: 'Content', authorId: user1.id })
      await posts.create({ title: 'U1 Post 2', content: 'Content', authorId: user1.id })
      await posts.create({ title: 'U2 Post 1', content: 'Content', authorId: user2.id })
      await posts.create({ title: 'U3 Post 1', content: 'Content', authorId: user3.id })
      await posts.create({ title: 'U3 Post 2', content: 'Content', authorId: user3.id })
      await posts.create({ title: 'U3 Post 3', content: 'Content', authorId: user3.id })

      const allUsers = [user1, user2, user3]

      const userPosts = hasMany('authorId', posts)
      const postsMap = await userPosts.loadMany(allUsers)

      // All users should have entries
      expect(postsMap.size).toBe(3)

      // User 1 has 2 posts
      const user1Posts = postsMap.get(user1.id)

      expect(user1Posts?.length).toBe(2)

      // User 2 has 1 post
      const user2Posts = postsMap.get(user2.id)

      expect(user2Posts?.length).toBe(1)

      // User 3 has 3 posts
      const user3Posts = postsMap.get(user3.id)

      expect(user3Posts?.length).toBe(3)
    })

    test('should count related entities without loading', async () => {
      const user = await users.create({ name: 'Count User', email: 'count@example.com' })

      await posts.create({ title: 'Post 1', content: 'Content', authorId: user.id })
      await posts.create({ title: 'Post 2', content: 'Content', authorId: user.id })
      await posts.create({ title: 'Post 3', content: 'Content', authorId: user.id })
      await posts.create({ title: 'Post 4', content: 'Content', authorId: user.id })

      const userPosts = hasMany('authorId', posts)
      const count = await userPosts.count(user)

      expect(count).toBe(4)
    })
  })

  describe('hasOne (One-to-One)', () => {
    test('should load a single related entity', async () => {
      const user = await users.create({ name: 'Profile User', email: 'profile@example.com' })

      await profiles.create({
        userId: user.id,
        bio: 'Software Developer',
        website: 'https://example.com',
      })

      const userProfile = hasOne('userId', profiles)
      const loadedProfile = await userProfile.load(user)

      expect(loadedProfile).not.toBeNull()
      expect(loadedProfile?.userId).toBe(user.id)
      expect(loadedProfile?.bio).toBe('Software Developer')
      expect(loadedProfile?.website).toBe('https://example.com')
    })

    test('should return null when no related entity exists', async () => {
      const user = await users.create({ name: 'No Profile', email: 'noprofile@example.com' })

      const userProfile = hasOne('userId', profiles)
      const loadedProfile = await userProfile.load(user)

      expect(loadedProfile).toBeNull()
    })

    test('should batch load related entities', async () => {
      const user1 = await users.create({ name: 'User 1', email: 'u1@profile.com' })
      const user2 = await users.create({ name: 'User 2', email: 'u2@profile.com' })
      const user3 = await users.create({ name: 'User 3', email: 'u3@profile.com' })

      await profiles.create({ userId: user1.id, bio: 'Bio 1', website: null })
      await profiles.create({ userId: user3.id, bio: 'Bio 3', website: null })
      // user2 has no profile

      const allUsers = [user1, user2, user3]

      const userProfile = hasOne('userId', profiles)
      const profilesMap = await userProfile.loadMany(allUsers)

      // Should have 2 profiles
      expect(profilesMap.size).toBe(2)
      expect(profilesMap.get(user1.id)?.bio).toBe('Bio 1')
      expect(profilesMap.get(user3.id)?.bio).toBe('Bio 3')
      expect(profilesMap.has(user2.id)).toBe(false)
    })
  })

  describe('Complex Relation Scenarios', () => {
    test('should handle multiple relation types together', async () => {
      const user = await users.create({ name: 'Multi Rel User', email: 'multi@example.com' })

      await profiles.create({ userId: user.id, bio: 'Developer', website: null })

      const post1 = await posts.create({ title: 'Post 1', content: 'Content', authorId: user.id })

      await posts.create({ title: 'Post 2', content: 'Content', authorId: user.id })

      await comments.create({ postId: post1.id, userId: user.id, content: 'Comment 1' })
      await comments.create({ postId: post1.id, userId: user.id, content: 'Comment 2' })

      // Load user's profile
      const userProfile = hasOne('userId', profiles)
      const loadedProfile = await userProfile.load(user)

      expect(loadedProfile?.bio).toBe('Developer')

      // Load user's posts
      const userPosts = hasMany('authorId', posts)
      const loadedPosts = await userPosts.load(user)

      expect(loadedPosts.length).toBe(2)

      // Load post's comments
      const postComments = hasMany('postId', comments)
      const loadedComments = await postComments.load(post1)

      expect(loadedComments.length).toBe(2)
    })

    test('should handle chained relations', async () => {
      const user = await users.create({ name: 'Chained User', email: 'chained@example.com' })
      const post = await posts.create({ title: 'Chained Post', content: 'Content', authorId: user.id })

      await comments.create({ postId: post.id, userId: user.id, content: 'Comment on own post' })

      // Load post -> author
      const postAuthor = belongsTo('authorId', users)
      const author = await postAuthor.load(post)

      expect(author?.name).toBe('Chained User')

      // Load post -> comments -> users
      const postComments = hasMany('postId', comments)
      const commentsList = await postComments.load(post)

      const commentAuthor = belongsTo('userId', users)
      const commentAuthorsMap = await commentAuthor.loadMany(commentsList)

      expect(commentAuthorsMap.get(user.id)?.name).toBe('Chained User')
    })
  })
})
