import type { Database, QueryErrorEvent, QueryEvent } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { UniqueError } from '../../src/index'
import { createTestDb, truncateAll } from '../helpers/db'
import { usersTable } from '../helpers/fixtures'

// Verifies that the default config (no explicit `redactParams`, no
// REDACT_QUERY_LOGS env var) does NOT leak sensitive values into the wrapped
// error's `message` or `params`. This is the production safety baseline.

let db: Database
const originalRedact = process.env.REDACT_QUERY_LOGS

beforeAll(async () => {
  // Default mode: no env, no redactor — should be safe.
  delete process.env.REDACT_QUERY_LOGS
  db = createTestDb()
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })

  if (originalRedact === undefined) {
    delete process.env.REDACT_QUERY_LOGS
  }
  else {
    process.env.REDACT_QUERY_LOGS = originalRedact
  }
})

describe('Default error redaction — production safety baseline', () => {
  it('UniqueError message does not contain the offending value verbatim', async () => {
    const repo = db.repo(usersTable)
    const secret = 'redact-test-leak@example.com'

    await repo.write.insertOne({ name: 'Alice', email: secret })

    try {
      await repo.write.insertOne({ name: 'Bob', email: secret })
      expect.unreachable('insertOne should have thrown UniqueError')
    }
    catch (err) {
      expect(err).toBeInstanceOf(UniqueError)
      // The whole point: even in dev (no NODE_ENV=production, no
      // REDACT_QUERY_LOGS=1), the value MUST NOT appear in the wrapped
      // message that is what most loggers serialize.
      expect((err as UniqueError).message).not.toContain(secret)
      // Structured constraint/table fields are preserved for programmatic handling.
      expect((err as UniqueError).constraint).toBeTruthy()
      expect((err as UniqueError).table).toBe('users')
    }
  })

  it('UniqueError.params does not contain the offending value (default scrub)', async () => {
    const repo = db.repo(usersTable)
    const secret = 'redact-test-params@example.com'

    await repo.write.insertOne({ name: 'Alice', email: secret })

    try {
      await repo.write.insertOne({ name: 'Bob', email: secret })
      expect.unreachable('insertOne should have thrown UniqueError')
    }
    catch (err) {
      const ue = err as UniqueError

      // Default redactor replaces values with '[REDACTED]'.
      for (const p of ue.params) {
        expect(p).not.toBe(secret)
      }
    }
  })

  it('the raw PG error is still accessible via .cause for explicit debugging', async () => {
    const repo = db.repo(usersTable)
    const secret = 'redact-test-cause@example.com'

    await repo.write.insertOne({ name: 'Alice', email: secret })

    try {
      await repo.write.insertOne({ name: 'Bob', email: secret })
      expect.unreachable('insertOne should have thrown UniqueError')
    }
    catch (err) {
      const cause = (err as Error).cause as Error & { detail?: string }

      expect(cause).toBeInstanceOf(Error)
      // bun:sql exposes the value-bearing text via `cause.detail` (PG's Detail
      // line), not in `cause.message`. Either way, the raw error object is
      // preserved on the cause chain for callers who explicitly need it.
      const haystack = `${cause.message} ${cause.detail ?? ''}`

      expect(haystack).toContain(secret)
    }
  })
})

describe('Query hook events', () => {
  async function capture(): Promise<{ query: QueryEvent, error: QueryErrorEvent }> {
    let query: QueryEvent | undefined
    let error: QueryErrorEvent | undefined
    const hooked = createTestDb({ onQuery: (e) => {
      query = e
    }, onError: (e) => {
      error = e
    } })

    await hooked.raw('SELECT $1::text AS v', ['hook-secret'])

    try {
      await hooked.raw('SELECT $1::int AS v', ['hook-secret'])
    }
    catch {
      // the failing cast is what fires onError
    }

    await hooked.close({ timeout: 5000 })

    return { query: query!, error: error! }
  }

  it('carry no params when REDACT_QUERY_LOGS=1', async () => {
    process.env.REDACT_QUERY_LOGS = '1'

    try {
      const { query, error } = await capture()

      expect(query.params).toEqual([])
      expect(error.params).toEqual([])
    }
    finally {
      delete process.env.REDACT_QUERY_LOGS
    }
  })

  it('keep params outside redaction so a dev debug hook still sees them', async () => {
    const { query } = await capture()

    expect(query.params).toEqual(['hook-secret'])
  })
})
