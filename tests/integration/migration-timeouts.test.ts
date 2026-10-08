import { afterAll, describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/db'

// One pooled connection, so the query after a migration runs on the connection the migration had.
const db = createTestDb({ statementTimeout: 100, idleInTransactionTimeout: 100, pool: { max: 1 } })

afterAll(async () => {
  await db.close()
})

describe('migrations under the pool\'s timeouts', () => {
  it('a migration transaction outlasts both, and an outside run the statement timeout, which the pool keeps', async () => {
    await db.migrate(async (query) => {
      await query('SELECT pg_sleep(0.3)', [])
      await Bun.sleep(300)

      return query('SELECT 1', [])
    })
    await db.migrateOutside(query => query('SELECT pg_sleep(0.3)', []))

    expect(await db.raw<{ statement_timeout: string }>('SHOW statement_timeout')).toEqual([{ statement_timeout: '100ms' }])
    expect(db.raw('SELECT pg_sleep(0.3)')).rejects.toThrow()
  }, 10_000)
})
