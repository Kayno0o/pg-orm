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

    await repo.write.insertOne({ name: 'Alice', email: secret }, { pk: true })

    try {
      await repo.write.insertOne({ name: 'Bob', email: secret }, { pk: true })
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

    await repo.write.insertOne({ name: 'Alice', email: secret }, { pk: true })

    try {
      await repo.write.insertOne({ name: 'Bob', email: secret }, { pk: true })
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

    await repo.write.insertOne({ name: 'Alice', email: secret }, { pk: true })

    try {
      await repo.write.insertOne({ name: 'Bob', email: secret }, { pk: true })
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

describe('Production error redaction', () => {
  // Everything a logger walking the error would print: the error, then each cause down the chain.
  function rendered(err: unknown): string {
    const parts: string[] = []

    for (let at: unknown = err; at; at = (at as { cause?: unknown }).cause)
      parts.push(Bun.inspect(at), JSON.stringify(at))

    return parts.join('\n')
  }

  async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn()
    }
    catch (err) {
      return err
    }

    return expect.unreachable('the query should have thrown')
  }

  it('leaves no row value reachable from a unique violation or a bad input, cause chain included', async () => {
    const repo = db.repo(usersTable)
    const secret = 'prod-leak)tail@example.com'

    await repo.write.insertOne({ name: 'Alice', email: secret }, { pk: true })
    process.env.NODE_ENV = 'production'

    try {
      const unique = await thrown(() => repo.write.insertOne({ name: 'Bob', email: secret }, { pk: true }))
      const badInput = await thrown(() => db.raw('SELECT $1::uuid', ['prod-secret-uuid']))

      expect(unique).toBeInstanceOf(UniqueError)
      expect(rendered(unique)).not.toContain('prod-leak')
      expect(rendered(unique)).not.toContain('tail@example.com')
      expect(rendered(badInput)).not.toContain('prod-secret-uuid')
      expect((unique as UniqueError).constraint).toBeTruthy()
    }
    finally {
      delete process.env.NODE_ENV
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

  it('scrub each param by default, even with NODE_ENV unset', async () => {
    const { query, error } = await capture()

    expect(query.params).toEqual(['[REDACTED]'])
    expect(error.params).toEqual(['[REDACTED]'])
  })

  it('carry raw params on REDACT_QUERY_LOGS=0', async () => {
    process.env.REDACT_QUERY_LOGS = '0'

    try {
      expect((await capture()).query.params).toEqual(['hook-secret'])
    }
    finally {
      delete process.env.REDACT_QUERY_LOGS
    }
  })
})

describe('debug logging', () => {
  it('prints the values a hook gets scrubbed', async () => {
    const lines: string[] = []
    const db = createTestDb({ debug: line => lines.push(line) })

    await db.raw('SELECT $1::text AS v', ['debug-value'])
    await db.close({ timeout: 5000 })

    expect(lines.some(line => line.includes('\'debug-value\''))).toBe(true)
  })
})

describe('OrmError cause', () => {
  it('is not enumerable, so serializing the error leaves the driver error out', async () => {
    const db = createTestDb()

    try {
      await db.raw('SELECT $1::int AS v', ['cause-secret'])
    }
    catch (err) {
      expect(Object.keys(err as object)).not.toContain('cause')
      expect(JSON.stringify(err)).not.toContain('cause-secret')
      expect((err as Error).cause).toBeInstanceOf(Error)
    }
    finally {
      await db.close({ timeout: 5000 })
    }

    expect.assertions(3)
  })
})
