import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createTestDb, truncateAll } from '../helpers/db'
import { usersTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
  await truncateAll(db)
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

describe('Soft Delete', () => {
  it('deleteMany sets deletedAt instead of removing row', async () => {
    const repo = db.repo(usersTable)
    const user = await repo.insertOne({ name: 'Alice', email: 'a@test.com' })

    await repo.deleteMany(e => e.eq('id', user.id))

    // Row should still exist in DB via withTrashed
    const all = await repo.findMany(q => q.withTrashed())

    expect(all).toHaveLength(1)
    expect((all[0] as any).deletedAt).not.toBeNull()
  })

  it('findMany excludes soft-deleted rows by default', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    await repo.insertOne({ name: 'Bob', email: 'b@test.com' })
    await repo.deleteMany(e => e.eq('email', 'a@test.com'))

    const users = await repo.findMany()

    expect(users).toHaveLength(1)
    expect(users[0]!.name).toBe('Bob')
  })

  it('withTrashed includes soft-deleted rows', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    await repo.deleteMany(e => e.eq('email', 'a@test.com'))

    const all = await repo.findMany(q => q.withTrashed())

    expect(all).toHaveLength(1)
  })

  it('count excludes soft-deleted rows', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    await repo.insertOne({ name: 'Bob', email: 'b@test.com' })
    await repo.deleteMany(e => e.eq('email', 'a@test.com'))

    const count = await repo.count()

    expect(count).toBe(1)
  })

  it('exists excludes soft-deleted rows', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    await repo.deleteMany(e => e.eq('email', 'a@test.com'))

    const exists = await repo.exists(e => e.eq('email', 'a@test.com'))

    expect(exists).toBe(false)
  })

  it('forceDelete removes row permanently', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    await repo.forceDelete(e => e.eq('email', 'a@test.com'))

    const all = await repo.findMany(q => q.withTrashed())

    expect(all).toHaveLength(0)
  })

  it('isDeleted virtual works correctly', async () => {
    const repo = db.repo(usersTable)

    const user = await repo.insertOne({ name: 'Alice', email: 'a@test.com' })

    expect((user as any).isDeleted).toBe(false)

    await repo.deleteMany(e => e.eq('id', user.id))
    const deleted = await repo.findMany(q => q.withTrashed())

    expect((deleted[0] as any).isDeleted).toBe(true)
  })

  it('deleteOne returns the soft-deleted row', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    const result = await repo.deleteOne(e => e.eq('email', 'a@test.com'))

    expect(result).not.toBeNull()
    expect((result as any).deletedAt).not.toBeNull()
  })
})
