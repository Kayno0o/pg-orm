import type { Database, QueryEvent } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/db'
import { postsTable, usersTable } from '../helpers/fixtures'

function inClauseQueryCount(events: QueryEvent[]): number {
  return events.filter(e => (/ IN \(/i).test(e.sql)).length
}

describe('Relation-loader IN-chunking at batchChunkSize boundary', () => {
  it('chunks IN queries when ids exceed batchChunkSize', async () => {
    const events: QueryEvent[] = []
    const db = createTestDb({
      batchChunkSize: 100,
      onQuery: e => events.push(e),
    })

    try {
      await db.sync({ allowDestructive: true })
      await db.raw('TRUNCATE "post_tags", "comments", "posts", "users" CASCADE', [])

      // Insert 250 users (forces 3 chunks at chunkSize=100)
      const users = Array.from({ length: 250 }, (_, i) => ({
        name: `u${i}`,
        email: `u${i}@batch.test`,
      }))
      const userIds = await db.repo(usersTable).write.insertMany(users, { pk: true })

      // One post per user
      const posts = userIds.map((id, i) => ({
        title: `p${i}`,
        body: 'body',
        authorId: id,
      }))

      await db.repo(postsTable).write.insertMany(posts, { pk: true })

      events.length = 0
      const result = await db.repo(usersTable).read.findMany(q => q.include('posts'))

      expect(result).toHaveLength(250)
      expect(result.every(u => u.posts.length === 1)).toBe(true)

      // 3 IN-queries: 100 + 100 + 50
      const inQueries = events.filter(e => (/FROM "posts".* IN \(/).test(e.sql))

      expect(inQueries).toHaveLength(3)
    }
    finally {
      await db.close({ timeout: 5000 })
    }
  })

  it('uses a single IN query when ids fit within batchChunkSize', async () => {
    const events: QueryEvent[] = []
    const db = createTestDb({
      batchChunkSize: 100,
      onQuery: e => events.push(e),
    })

    try {
      await db.sync({ allowDestructive: true })
      await db.raw('TRUNCATE "post_tags", "comments", "posts", "users" CASCADE', [])

      // Exactly batchChunkSize → still one chunk (boundary is `<=`)
      const users = Array.from({ length: 100 }, (_, i) => ({
        name: `u${i}`,
        email: `u${i}@batch.test`,
      }))
      const userIds = await db.repo(usersTable).write.insertMany(users, { pk: true })
      const posts = userIds.map((id, i) => ({
        title: `p${i}`,
        body: 'body',
        authorId: id,
      }))

      await db.repo(postsTable).write.insertMany(posts, { pk: true })

      events.length = 0
      const result = await db.repo(usersTable).read.findMany(q => q.include('posts'))

      expect(result).toHaveLength(100)

      const inQueries = events.filter(e => (/FROM "posts".* IN \(/).test(e.sql))

      expect(inQueries).toHaveLength(1)
    }
    finally {
      await db.close({ timeout: 5000 })
    }
  })

  it('forces a second chunk one row over the boundary', async () => {
    const events: QueryEvent[] = []
    const db = createTestDb({
      batchChunkSize: 100,
      onQuery: e => events.push(e),
    })

    try {
      await db.sync({ allowDestructive: true })
      await db.raw('TRUNCATE "post_tags", "comments", "posts", "users" CASCADE', [])

      const users = Array.from({ length: 101 }, (_, i) => ({
        name: `u${i}`,
        email: `u${i}@batch.test`,
      }))
      const userIds = await db.repo(usersTable).write.insertMany(users, { pk: true })
      const posts = userIds.map((id, i) => ({
        title: `p${i}`,
        body: 'body',
        authorId: id,
      }))

      await db.repo(postsTable).write.insertMany(posts, { pk: true })

      events.length = 0
      const result = await db.repo(usersTable).read.findMany(q => q.include('posts'))

      expect(result).toHaveLength(101)

      const inQueries = events.filter(e => (/FROM "posts".* IN \(/).test(e.sql))

      expect(inQueries).toHaveLength(2)
      expect(inClauseQueryCount(inQueries)).toBe(2)
    }
    finally {
      await db.close({ timeout: 5000 })
    }
  })
})

// --- Default 5000 boundary ---
// Separate suite so we use the production default and confirm the constant.
describe('Relation-loader IN-chunking at default 5000 boundary', () => {
  let db: Database
  const events: QueryEvent[] = []

  beforeAll(async () => {
    db = createTestDb({
      onQuery: e => events.push(e),
    })
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    await db.raw('TRUNCATE "post_tags", "comments", "posts", "users" CASCADE', [])
    events.length = 0
  })

  afterAll(async () => {
    await db.close({ timeout: 5000 })
  })

  it('single-chunk at exactly 5000 parents', async () => {
    const users = Array.from({ length: 5000 }, (_, i) => ({
      name: `u${i}`,
      email: `u${i}@5k.test`,
    }))
    const userIds = await db.repo(usersTable).write.insertMany(users, { pk: true })

    expect(userIds).toHaveLength(5000)

    const posts = userIds.map((id, i) => ({
      title: `p${i}`,
      body: 'b',
      authorId: id,
    }))

    await db.repo(postsTable).write.insertMany(posts, { pk: true })

    events.length = 0
    const result = await db.repo(usersTable).read.findMany(q => q.include('posts'))

    expect(result).toHaveLength(5000)

    const inQueries = events.filter(e => (/FROM "posts".* IN \(/).test(e.sql))

    expect(inQueries).toHaveLength(1)
  }, 60_000)

  it('two-chunk at 5001 parents', async () => {
    const users = Array.from({ length: 5001 }, (_, i) => ({
      name: `u${i}`,
      email: `u${i}@5k.test`,
    }))
    const userIds = await db.repo(usersTable).write.insertMany(users, { pk: true })
    const posts = userIds.map((id, i) => ({
      title: `p${i}`,
      body: 'b',
      authorId: id,
    }))

    await db.repo(postsTable).write.insertMany(posts, { pk: true })

    events.length = 0
    const result = await db.repo(usersTable).read.findMany(q => q.include('posts'))

    expect(result).toHaveLength(5001)

    const inQueries = events.filter(e => (/FROM "posts".* IN \(/).test(e.sql))

    expect(inQueries).toHaveLength(2)
  }, 60_000)
})
