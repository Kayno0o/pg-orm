import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createTestDb, truncateAll } from '../helpers/db'
import { commentsTable, postsTable, tagsTable, usersTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

async function seedRelations() {
  const userRepo = db.repo(usersTable)
  const postRepo = db.repo(postsTable)
  const commentRepo = db.repo(commentsTable)
  const tagRepo = db.repo(tagsTable)

  const aliceId = await userRepo.write.insertOne({ name: 'Alice', email: 'alice@test.com' }, { pk: true })
  const bobId = await userRepo.write.insertOne({ name: 'Bob', email: 'bob@test.com' }, { pk: true })

  const post1Id = await postRepo.write.insertOne({ title: 'Post 1', body: 'Body 1', authorId: aliceId }, { pk: true })
  const post2Id = await postRepo.write.insertOne({ title: 'Post 2', body: 'Body 2', authorId: aliceId }, { pk: true })
  const post3Id = await postRepo.write.insertOne({ title: 'Post 3', body: 'Body 3', authorId: bobId }, { pk: true })

  await commentRepo.write.insertOne({ body: 'Comment 1', postId: post1Id, authorId: bobId }, { pk: true })
  await commentRepo.write.insertOne({ body: 'Comment 2', postId: post1Id, authorId: aliceId }, { pk: true })
  await commentRepo.write.insertOne({ body: 'Comment 3', postId: post2Id, authorId: bobId }, { pk: true })

  const tag1Id = await tagRepo.write.insertOne({ name: 'typescript' }, { pk: true })
  const tag2Id = await tagRepo.write.insertOne({ name: 'postgres' }, { pk: true })

  // Wire post_tags
  await db.raw('INSERT INTO "post_tags" ("postId", "tagId") VALUES ($1, $2)', [post1Id, tag1Id])
  await db.raw('INSERT INTO "post_tags" ("postId", "tagId") VALUES ($1, $2)', [post1Id, tag2Id])
  await db.raw('INSERT INTO "post_tags" ("postId", "tagId") VALUES ($1, $2)', [post2Id, tag1Id])

  return { aliceId, bobId, post1Id, post2Id, post3Id, tag1Id, tag2Id }
}

describe('belongsTo', () => {
  it('loads parent relation', async () => {
    const { post1Id } = await seedRelations()
    const postRepo = db.repo(postsTable)
    const posts = await postRepo.read.findMany(q => q.include('author').where(e => e.eq('id', post1Id)))

    expect(posts).toHaveLength(1)
    expect(posts[0]!.author).toBeDefined()
    expect(posts[0]!.author.name).toBe('Alice')
  })

  it('sets null when FK is null', async () => {
    const postRepo = db.repo(postsTable)
    // Insert a post without matching the seed
    const userRepo = db.repo(usersTable)
    const userId = await userRepo.write.insertOne({ name: 'Test', email: 'test@test.com' }, { pk: true })

    await postRepo.write.insertOne({ title: 'Orphan', body: 'body', authorId: userId }, { pk: true })

    // Delete the user to make the FK dangle (force delete bypasses soft-delete)
    await userRepo.write.forceDelete(e => e.eq('id', userId), { pk: true })

    const posts = await postRepo.read.findMany(q => q.include('author'))
    const orphan = posts.find(p => p.title === 'Orphan')

    expect(orphan!.author).toBeNull()
  })
})

describe('hasMany', () => {
  it('loads children', async () => {
    const { aliceId } = await seedRelations()
    const userRepo = db.repo(usersTable)
    const users = await userRepo.read.findMany(q => q.include('posts').where(e => e.eq('id', aliceId)))

    expect(users).toHaveLength(1)
    expect(users[0]!.posts).toHaveLength(2)
  })

  it('returns empty array when no children', async () => {
    const userRepo = db.repo(usersTable)
    const userId = await userRepo.write.insertOne({ name: 'Loner', email: 'loner@test.com' }, { pk: true })

    const users = await userRepo.read.findMany(q => q.include('posts').where(e => e.eq('id', userId)))

    expect(users[0]!.posts).toEqual([])
  })
})

describe('nested includes', () => {
  it('loads nested relations via callback composition', async () => {
    await seedRelations()
    const userRepo = db.repo(usersTable)
    const users = await userRepo.read.findMany(q =>
      q.include('posts', postsTable, pq =>
        pq.include('comments')))

    const alice = users.find(u => u.name === 'Alice')!

    expect(alice.posts).toBeDefined()

    const postsWithComments = alice.posts.filter(p => p.comments?.length > 0)

    expect(postsWithComments.length).toBeGreaterThan(0)
  })

  it('supports filtering with nested includes', async () => {
    const { aliceId } = await seedRelations()
    const userRepo = db.repo(usersTable)
    const users = await userRepo.read.findMany(q =>
      q.include('posts', postsTable, pq =>
        pq.where(e => e.eq('title', 'Post 1'))
          .include('comments', commentsTable, cq => cq))
        .where(e => e.eq('id', aliceId)))

    expect(users[0]!.posts).toHaveLength(1)
    expect(users[0]!.posts[0]!.title).toBe('Post 1')
    expect(users[0]!.posts[0]!.comments.length).toBeGreaterThan(0)
  })
})

describe('hasManyThrough', () => {
  it('loads through relations', async () => {
    const { post1Id } = await seedRelations()
    const postRepo = db.repo(postsTable)
    const posts = await postRepo.read.findMany(q =>
      q.include('tags').where(e => e.eq('id', post1Id)))

    expect(posts).toHaveLength(1)
    expect(posts[0]!.tags).toHaveLength(2)

    const tagNames = posts[0]!.tags.map(t => t.name).sort()

    expect(tagNames).toEqual(['postgres', 'typescript'])
  })

  it('returns empty array for post with no tags', async () => {
    const { post3Id } = await seedRelations()
    const postRepo = db.repo(postsTable)
    const posts = await postRepo.read.findMany(q =>
      q.include('tags').where(e => e.eq('id', post3Id)))

    expect(posts[0]!.tags).toEqual([])
  })

  it('uses __pgorm_pivot_fk__ internally (no collision)', async () => {
    const { post1Id } = await seedRelations()
    const postRepo = db.repo(postsTable)
    const posts = await postRepo.read.findMany(q =>
      q.include('tags').where(e => e.eq('id', post1Id)))

    // The pivot FK should be cleaned up from the result
    const tag = posts[0]!.tags[0]

    expect(tag).not.toHaveProperty('__pgorm_pivot_fk__')
    expect(tag).not.toHaveProperty('__pivot_fk')
  })
})

describe('filtered includes', () => {
  it('applies callback filter to included relation', async () => {
    const { aliceId } = await seedRelations()
    const userRepo = db.repo(usersTable)
    const users = await userRepo.read.findMany(q =>
      q.include('posts', postsTable, pq => pq.where(e => e.eq('title', 'Post 1'))).where(e => e.eq('id', aliceId)))

    expect(users[0]!.posts).toHaveLength(1)
    expect(users[0]!.posts[0]!.title).toBe('Post 1')
  })
})

describe('large batch chunking', () => {
  it('handles more than a few rows without error', async () => {
    const userRepo = db.repo(usersTable)
    const postRepo = db.repo(postsTable)

    const userIds = await userRepo.write.insertMany(
      Array.from({ length: 20 }, (_, i) => ({ name: `User${i}`, email: `user${i}@test.com` })),
      { pk: true },
    )
    const users = await userRepo.read.findMany(q => q.where(e => e.in('id', userIds)))

    for (const user of users) {
      await postRepo.write.insertOne({ title: `Post by ${user.name}`, body: 'body', authorId: user.id }, { pk: true })
    }

    const result = await userRepo.read.findMany(q => q.include('posts'))

    expect(result).toHaveLength(20)

    for (const u of result) {
      expect(u.posts).toHaveLength(1)
    }
  })
})
