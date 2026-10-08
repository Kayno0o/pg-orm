import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createTestDb, truncateAll } from '../helpers/db'
import { usersTable } from '../helpers/fixtures'

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

describe('Streaming', () => {
  it('yields all rows', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertMany(
      Array.from({ length: 10 }, (_, i) => ({ name: `User${i}`, email: `u${i}@test.com` })),
      { pk: true },
    )

    const rows: any[] = []

    for await (const row of repo.stream.stream()) {
      rows.push(row)
    }

    expect(rows).toHaveLength(10)
  })

  it('respects chunkSize', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertMany(
      Array.from({ length: 8 }, (_, i) => ({ name: `User${i}`, email: `u${i}@test.com` })),
      { pk: true },
    )

    const rows: any[] = []

    for await (const row of repo.stream.stream(undefined, { chunkSize: 3 })) {
      rows.push(row)
    }

    expect(rows).toHaveLength(8)
  })

  it('applies filter callback', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertMany([
      { name: 'Alice', email: 'a@test.com', age: 30 },
      { name: 'Bob', email: 'b@test.com', age: 20 },
      { name: 'Charlie', email: 'c@test.com', age: 40 },
    ], { pk: true })

    const rows: any[] = []

    for await (const row of repo.stream.stream(q => q.where(e => e.gt('age', 25)))) {
      rows.push(row)
    }

    expect(rows).toHaveLength(2)
  })

  it('returns virtuals on streamed rows', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })

    for await (const row of repo.stream.stream()) {
      // isDeleted is a virtual from softDelete trait
      expect(row.isDeleted).toBe(false)
    }
  })

  it('handles empty table', async () => {
    const repo = db.repo(usersTable)
    const rows: any[] = []

    for await (const row of repo.stream.stream()) {
      rows.push(row)
    }

    expect(rows).toHaveLength(0)
  })
})
