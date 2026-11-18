import type { DbConfig } from '../../src/index'
import { Database } from '../../src/index'
import { allTables } from './fixtures'

export const TEST_URL = process.env.DATABASE_URL ?? 'postgres://test:test@127.0.0.1:8532/orm_test'

// CI's system-installed PG occasionally drops idle sockets between tests.
// Retry transient ConnectionError so the suite is robust without masking real issues.
const DEFAULT_RETRY: DbConfig['retry'] = { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 500 }

export function createTestDb(overrides: Partial<DbConfig> = {}): Database {
  return new Database({
    url: TEST_URL,
    tables: allTables,
    retry: DEFAULT_RETRY,
    ...overrides,
  })
}

export async function withTestDb(
  fnOrOverrides: ((db: Database) => Promise<void>) | Partial<DbConfig>,
  maybeFn?: (db: Database) => Promise<void>,
): Promise<void> {
  const fn = typeof fnOrOverrides === 'function' ? fnOrOverrides : maybeFn!
  const overrides = typeof fnOrOverrides === 'object' ? fnOrOverrides : undefined
  const db = createTestDb(overrides)

  try {
    await db.sync({ allowDestructive: true })
    await fn(db)
  }
  finally {
    await db.close({ timeout: 5000 })
  }
}

export async function truncateAll(db: Database): Promise<void> {
  await db.raw('TRUNCATE "post_tags", "comments", "posts", "tags", "versioned_items", "users", "items", "documents", "big_items" CASCADE', [])
}

export async function dropAllTables(db: Database): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS "post_tags", "comments", "posts", "versioned_items", "tags", "users", "items", "documents", "big_items" CASCADE', [])
}

/** Resolves once another session of the test database is waiting on a lock, so a test can release the holder knowing the waiter is queued. */
export async function waitForLockWaiter(db: Database): Promise<void> {
  const deadline = Date.now() + 5000

  while (Date.now() < deadline) {
    const waiting = await db.raw('SELECT 1 FROM pg_stat_activity WHERE wait_event_type = \'Lock\' AND datname = current_database() AND pid <> pg_backend_pid()')

    if (waiting.length > 0)
      return

    await Bun.sleep(5)
  }

  throw new Error('no session started waiting on a lock within 5 s')
}

/** The test server's `server_version_num` (190000 for Postgres 19), for a test needing a newer server than the oldest one supported. */
export async function serverVersion(): Promise<number> {
  const probe = createTestDb({ tables: [] })

  try {
    const [row] = await probe.raw<{ v: number }>('SELECT current_setting(\'server_version_num\')::int AS v')

    return row?.v ?? 0
  }
  finally {
    await probe.close()
  }
}
