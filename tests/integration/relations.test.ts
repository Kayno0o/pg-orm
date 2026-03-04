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

  const alice = await userRepo.insertOne({ name: 'Alice', email: 'alice@test.com' })
  const bob = await userRepo.insertOne({ name: 'Bob', email: 'bob@test.com' })

  const post1 = await postRepo.insertOne({ title: 'Post 1', body: 'Body 1', authorId: alice.id })
  const post2 = await postRepo.insertOne({ title: 'Post 2', body: 'Body 2', authorId: alice.id })
  const post3 = await postRepo.insertOne({ title: 'Post 3', body: 'Body 3', authorId: bob.id })

  await commentRepo.insertOne({ body: 'Comment 1', postId: post1.id, authorId: bob.id })
  await commentRepo.insertOne({ body: 'Comment 2', postId: post1.id, authorId: alice.id })
  await commentRepo.insertOne({ body: 'Comment 3', postId: post2.id, authorId: bob.id })

  const tag1 = await tagRepo.insertOne({ name: 'typescript' })
  const tag2 = await tagRepo.insertOne({ name: 'postgres' })

  // Wire post_tags
  await db.raw('INSERT INTO "post_tags" ("postId", "tagId") VALUES ($1, $2)', [post1.id, tag1.id])
  await db.raw('INSERT INTO "post_tags" ("postId", "tagId") VALUES ($1, $2)', [post1.id, tag2.id])
  await db.raw('INSERT INTO "post_tags" ("postId", "tagId") VALUES ($1, $2)', [post2.id, tag1.id])

  return { alice, bob, post1, post2, post3, tag1, tag2 }
}

describe('belongsTo', () => {
  it('loads parent relation', async () => {
    const { post1, alice: _alice } = await seedRelations()
    const postRepo = db.repo(postsTable)
    const posts = await postRepo.findMany(q => (q as any).include('author').where((e: any) => e.eq('id', post1.id)))

    expect(posts).toHaveLength(1)
    expect((posts[0] as any).author).toBeDefined()
    expect((posts[0] as any).author.name).toBe('Alice')
  })

  it('sets null when FK is null', async () => {
    const postRepo = db.repo(postsTable)
    // Insert a post without matching the seed
    const userRepo = db.repo(usersTable)
    const user = await userRepo.insertOne({ name: 'Test', email: 'test@test.com' })

    await postRepo.insertOne({ title: 'Orphan', body: 'body', authorId: user.id })

    // Delete the user to make the FK dangle (force delete bypasses soft-delete)
    await userRepo.forceDelete(e => e.eq('id', user.id))

    const posts = await postRepo.findMany(q => (q as any).include('author'))
    const orphan = posts.find((p: any) => p.title === 'Orphan')

    expect((orphan as any).author).toBeNull()
  })
})

describe('hasMany', () => {
  it('loads children', async () => {
    const { alice } = await seedRelations()
    const userRepo = db.repo(usersTable)
    const users = await userRepo.findMany(q => (q as any).include('posts').where((e: any) => e.eq('id', alice.id)))

    expect(users).toHaveLength(1)
    expect((users[0] as any).posts).toHaveLength(2)
  })

  it('returns empty array when no children', async () => {
    const userRepo = db.repo(usersTable)
    const user = await userRepo.insertOne({ name: 'Loner', email: 'loner@test.com' })

    const users = await userRepo.findMany(q => (q as any).include('posts').where((e: any) => e.eq('id', user.id)))

    expect((users[0] as any).posts).toEqual([])
  })
})

describe('nested includes', () => {
  it('loads nested relations via dotted path', async () => {
    await seedRelations()
    const userRepo = db.repo(usersTable)
    const users = await userRepo.findMany(q =>
      (q as any).include('posts').include('posts.comments'))

    const alice = users.find((u: any) => u.name === 'Alice')!

    expect((alice as any).posts).toBeDefined()

    const postsWithComments = (alice as any).posts.filter((p: any) => p.comments?.length > 0)

    expect(postsWithComments.length).toBeGreaterThan(0)
  })
})

describe('hasManyThrough', () => {
  it('loads through relations', async () => {
    const { post1 } = await seedRelations()
    const postRepo = db.repo(postsTable)
    const posts = await postRepo.findMany(q =>
      (q as any).include('tags').where((e: any) => e.eq('id', post1.id)))

    expect(posts).toHaveLength(1)
    expect((posts[0] as any).tags).toHaveLength(2)

    const tagNames = (posts[0] as any).tags.map((t: any) => t.name).sort()

    expect(tagNames).toEqual(['postgres', 'typescript'])
  })

  it('returns empty array for post with no tags', async () => {
    const { post3 } = await seedRelations()
    const postRepo = db.repo(postsTable)
    const posts = await postRepo.findMany(q =>
      (q as any).include('tags').where((e: any) => e.eq('id', post3.id)))

    expect((posts[0] as any).tags).toEqual([])
  })

  it('uses __pgorm_pivot_fk__ internally (no collision)', async () => {
    const { post1 } = await seedRelations()
    const postRepo = db.repo(postsTable)
    const posts = await postRepo.findMany(q =>
      (q as any).include('tags').where((e: any) => e.eq('id', post1.id)))

    // The pivot FK should be cleaned up from the result
    const tag = (posts[0] as any).tags[0]

    expect(tag).not.toHaveProperty('__pgorm_pivot_fk__')
    expect(tag).not.toHaveProperty('__pivot_fk')
  })
})

describe('filtered includes', () => {
  it('applies callback filter to included relation', async () => {
    const { alice } = await seedRelations()
    const userRepo = db.repo(usersTable)
    const users = await userRepo.findMany(q =>
      (q as any).include('posts', (pq: any) => pq.where((e: any) => e.eq('title', 'Post 1'))).where((e: any) => e.eq('id', alice.id)))

    expect((users[0] as any).posts).toHaveLength(1)
    expect((users[0] as any).posts[0].title).toBe('Post 1')
  })
})

describe('large batch chunking', () => {
  it('handles more than a few rows without error', async () => {
    const userRepo = db.repo(usersTable)
    const postRepo = db.repo(postsTable)

    const users = await userRepo.insertMany(
      Array.from({ length: 20 }, (_, i) => ({ name: `User${i}`, email: `user${i}@test.com` })),
    )

    for (const user of users) {
      await postRepo.insertOne({ title: `Post by ${user.name}`, body: 'body', authorId: user.id })
    }

    const result = await userRepo.findMany(q => (q as any).include('posts'))

    expect(result).toHaveLength(20)

    for (const u of result) {
      expect((u as any).posts).toHaveLength(1)
    }
  })
})
