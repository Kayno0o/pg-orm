import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { ForeignKeyError, NotNullError, UniqueError } from '../../src/index'
import { createTestDb, truncateAll } from '../helpers/db'
import { postsTable, usersTable } from '../helpers/fixtures'

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

describe('Error Wrapping - integration', () => {
  it('throws UniqueError on duplicate unique column', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'dup@test.com' })

    await expect(
      repo.insertOne({ name: 'Bob', email: 'dup@test.com' }),
    ).rejects.toThrow(UniqueError)
  })

  it('UniqueError has structured info', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'dup@test.com' })

    try {
      await repo.insertOne({ name: 'Bob', email: 'dup@test.com' })
      expect.unreachable('should have thrown')
    }
    catch (err) {
      expect(err).toBeInstanceOf(UniqueError)

      const ue = err as UniqueError

      expect(ue.table).toBe('users')
      expect(ue.constraint).toBeTruthy()
    }
  })

  it('throws ForeignKeyError on invalid FK', async () => {
    // Add FK constraint manually since .references() API isn't used in fixtures
    try {
      await db.raw('ALTER TABLE "posts" ADD CONSTRAINT "posts_author_fk" FOREIGN KEY ("authorId") REFERENCES "users" ("id") NOT VALID', [])
    }
    catch { /* ignore if already exists */ }

    try {
      await db.raw('ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_author_fk"', [])
    }
    catch { /* ignore */ }

    try {
      const postRepo = db.repo(postsTable)

      await expect(
        postRepo.insertOne({ title: 'Bad', body: 'body', authorId: 999999 }),
      ).rejects.toThrow(ForeignKeyError)
    }
    finally {
      // Clean up FK constraint to avoid affecting other tests
      try {
        await db.raw('ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_author_fk"', [])
      }
      catch { /* ignore */ }
    }
  })

  it('throws NotNullError on null required column', async () => {
    const repo = db.repo(usersTable)

    await expect(
      repo.insertOne({ name: null, email: 'test@test.com' } as any),
    ).rejects.toThrow(NotNullError)
  })

  it('ping returns true when DB is up', async () => {
    const result = await db.ping()

    expect(result).toBe(true)
  })

  it('close disconnects cleanly', async () => {
    const tempDb = createTestDb()

    await tempDb.ping()
    await tempDb.close({ timeout: 5000 })

    // After close, raw queries should fail
    await expect(tempDb.raw('SELECT 1', [])).rejects.toThrow()
  })
})
