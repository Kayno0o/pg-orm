import { Database } from '../../src/index'
import { allTables } from './fixtures'

const TEST_URL = process.env.database_url ?? 'postgres://test:test@127.0.0.1:8532/orm_test'

export function createTestDb(): Database {
  return new Database({
    url: TEST_URL,
    tables: allTables,
  })
}

export async function withTestDb(fn: (db: Database) => Promise<void>): Promise<void> {
  const db = createTestDb()

  try {
    await db.sync({ allowDestructive: true })
    await fn(db)
  }
  finally {
    await db.close({ timeout: 5000 })
  }
}

export async function truncateAll(db: Database): Promise<void> {
  await db.raw('TRUNCATE "post_tags", "comments", "posts", "tags", "versioned_items", "users", "items" CASCADE', [])
}

export async function dropAllTables(db: Database): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS "post_tags", "comments", "posts", "versioned_items", "tags", "users", "items" CASCADE', [])
}
