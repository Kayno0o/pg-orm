import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { ConnectionError, UniqueError } from '../../src/index'
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

describe('Transactions', () => {
  it('commits on success', async () => {
    await db.transaction(async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.write.insertOne({ name: 'Alice', email: 'alice@test.com' }, { pk: true })
    })

    const count = await db.repo(usersTable).read.count()

    expect(count).toBe(1)
  })

  it('rolls back on error', async () => {
    try {
      await db.transaction(async (tx) => {
        const repo = db.repo(usersTable).using(tx)

        await repo.write.insertOne({ name: 'Alice', email: 'alice@test.com' }, { pk: true })

        throw new Error('rollback!')
      })
    }
    catch {
      // expected
    }

    const count = await db.repo(usersTable).read.count()

    expect(count).toBe(0)
  })

  it('supports savepoints', async () => {
    await db.transaction(async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.write.insertOne({ name: 'Alice', email: 'alice@test.com' }, { pk: true })

      try {
        await tx.savepoint(async (sp) => {
          const spRepo = db.repo(usersTable).using(sp)

          await spRepo.write.insertOne({ name: 'Bob', email: 'bob@test.com' }, { pk: true })

          throw new Error('savepoint rollback')
        })
      }
      catch {
        // savepoint rolled back
      }

      // Alice should still be committed within the transaction
    })

    const users = await db.repo(usersTable).read.findMany()

    expect(users).toHaveLength(1)
    expect(users[0]!.name).toBe('Alice')
  })

  it('supports isolation level: serializable', async () => {
    await db.transaction({ isolation: 'serializable' }, async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.write.insertOne({ name: 'Serialized', email: 'serial@test.com' }, { pk: true })
    })

    const count = await db.repo(usersTable).read.count()

    expect(count).toBe(1)
  })

  it('supports isolation level: read committed', async () => {
    await db.transaction({ isolation: 'read committed' }, async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.write.insertOne({ name: 'RC', email: 'rc@test.com' }, { pk: true })
    })

    const count = await db.repo(usersTable).read.count()

    expect(count).toBe(1)
  })

  it('supports read-only access mode', async () => {
    // Insert a row first
    await db.repo(usersTable).write.insertOne({ name: 'Existing', email: 'existing@test.com' }, { pk: true })

    await db.transaction({ isolation: 'read committed', accessMode: 'read only' }, async (tx) => {
      const repo = db.repo(usersTable).using(tx)
      const users = await repo.read.findMany()

      expect(users).toHaveLength(1)
    })
  })

  it('rejects invalid isolation level', async () => {
    expect(
      // @ts-expect-error check invalid value
      db.transaction({ isolation: 'invalid' }, async () => { /* noop */ }),
    ).rejects.toThrow()
  })

  it('repos use transaction executor', async () => {
    await db.transaction(async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.write.insertOne({ name: 'TxUser', email: 'tx@test.com' }, { pk: true })
      const found = await repo.read.findOne(q => q.where(e => e.eq('email', 'tx@test.com')))

      expect(found).not.toBeNull()
    })
  })

  it('nested savepoints work', async () => {
    await db.transaction(async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.write.insertOne({ name: 'Outer', email: 'outer@test.com' }, { pk: true })

      await tx.savepoint(async (sp1) => {
        const spRepo = db.repo(usersTable).using(sp1)

        await spRepo.write.insertOne({ name: 'Inner', email: 'inner@test.com' }, { pk: true })
      })
    })

    const count = await db.repo(usersTable).read.count()

    expect(count).toBe(2)
  })
})

describe('Transaction settlement', () => {
  it('maps a constraint that fails at COMMIT to its typed error', async () => {
    await db.raw('CREATE TABLE IF NOT EXISTS "tx_deferred" ("v" int UNIQUE DEFERRABLE INITIALLY DEFERRED)')

    try {
      const run = db.transaction(async (tx) => {
        await tx.query('INSERT INTO "tx_deferred" ("v") VALUES (1), (1)', [])
      })

      await expect(run).rejects.toBeInstanceOf(UniqueError)
    }
    finally {
      await db.raw('DROP TABLE "tx_deferred"')
    }
  })

  it('close({ drain }) rejects new transactions and waits for the running one', async () => {
    const draining = createTestDb()
    let committed = false

    const running = draining.transaction(async (tx) => {
      await tx.query('SELECT pg_sleep(0.2)', [])
      committed = true
    })

    await Bun.sleep(20)
    const closing = draining.close({ drain: true, timeout: 5000 })

    await expect(draining.transaction(async () => 'never runs')).rejects.toBeInstanceOf(ConnectionError)
    await running
    await closing

    expect(committed).toBe(true)
  })

  it('close({ drain }) still runs the queries a transaction begun before it issues on the pool', async () => {
    const draining = createTestDb()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const running = draining.transaction(async () => {
      await gate

      return draining.query('SELECT 1 AS one', [])
    })

    await Bun.sleep(20)
    const closing = draining.close({ drain: true, timeout: 5000 })

    release()

    expect(await running).toEqual([{ one: 1 }])
    await closing
  })

  it('close() without drain fails a later query at once, without retrying it', async () => {
    const closing = createTestDb({ retry: { maxRetries: 5, baseDelayMs: 200, maxDelayMs: 1000 } })

    await closing.query('SELECT 1', [])

    const closed = closing.close({ timeout: 1000 })
    const started = performance.now()

    await expect(closing.query('SELECT 1', [])).rejects.toBeInstanceOf(ConnectionError)
    expect(performance.now() - started).toBeLessThan(100)
    await closed
  })
})

describe('db.transaction() called inside a transaction body', () => {
  it('sees the outer transaction\'s uncommitted writes', async () => {
    await db.transaction(async (tx) => {
      await db.repo(usersTable).using(tx).write.insertOne({ name: 'Outer', email: 'outer@test.com' }, { pk: true })

      const seen = await db.transaction(async inner => db.repo(usersTable).using(inner).read.count({ email: 'outer@test.com' }))

      expect(seen).toBe(1)
    })
  })

  it('rolls back with the outer transaction', async () => {
    try {
      await db.transaction(async () => {
        await db.transaction(async inner => db.repo(usersTable).using(inner).write.insertOne({ name: 'Inner', email: 'inner@test.com' }, { pk: true }))

        throw new Error('outer fails after the inner one returned')
      })
    }
    catch {
      // expected
    }

    expect(await db.repo(usersTable).read.count({ email: 'inner@test.com' })).toBe(0)
  })

  it('undoes only its own writes when it fails and the outer body carries on', async () => {
    const users = db.repo(usersTable)

    await db.transaction(async (tx) => {
      await users.using(tx).write.insertOne({ name: 'Outer', email: 'kept@test.com' }, { pk: true })

      try {
        await db.transaction(async (inner) => {
          await users.using(inner).write.insertOne({ name: 'Inner', email: 'undone@test.com' }, { pk: true })

          throw new Error('inner fails')
        })
      }
      catch {
        // the outer transaction is still usable
      }

      await users.using(tx).write.insertOne({ name: 'After', email: 'after@test.com' }, { pk: true })
    })

    expect(await users.read.count({ email: ['kept@test.com', 'after@test.com'] })).toBe(2)
    expect(await users.read.count({ email: 'undone@test.com' })).toBe(0)
  })

  it('fires its onCommit only once the outer transaction commits, and its onRollback when it fails', async () => {
    const events: string[] = []

    await db.transaction(async () => {
      await db.transaction(async (inner) => {
        inner.onCommit(() => {
          events.push('inner committed')
        })
      })

      try {
        await db.transaction(async (inner) => {
          inner.onRollback(() => {
            events.push('failed inner rolled back')
          })

          throw new Error('inner fails')
        })
      }
      catch {
        // expected
      }

      events.push('outer body done')
    })

    expect(events).toEqual(['failed inner rolled back', 'outer body done', 'inner committed'])
  })

  it('runs sibling nested calls one after the other, each undone on its own', async () => {
    const users = db.repo(usersTable)

    await db.transaction(async () => {
      const results = await Promise.allSettled([
        db.transaction(async inner => users.using(inner).write.insertOne({ name: 'A', email: 'a@sibling.com' }, { pk: true })),
        db.transaction(async (inner) => {
          await users.using(inner).write.insertOne({ name: 'B', email: 'b@sibling.com' }, { pk: true })

          throw new Error('b fails')
        }),
        db.transaction(async inner => users.using(inner).write.insertOne({ name: 'C', email: 'c@sibling.com' }, { pk: true })),
      ])

      expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    })

    expect((await users.read.findManyBy({ email: { endsWith: '@sibling.com' } })).map(u => u.name).sort()).toEqual(['A', 'C'])
  })

  it('never joins a transaction of another Database', async () => {
    const other = createTestDb()

    try {
      await db.transaction(async (tx) => {
        const [outer] = await tx.query('SELECT pg_backend_pid() AS pid', [])
        const inner = await other.transaction(async otherTx => (await otherTx.query('SELECT pg_backend_pid() AS pid', []))[0])

        expect(inner!.pid).not.toBe(outer!.pid)
      })
    }
    finally {
      await other.close({ timeout: 5000 })
    }
  })

  it('refuses an isolation level it cannot apply', async () => {
    await db.transaction(async () => {
      await expect(db.transaction({ isolation: 'serializable' }, async () => 1)).rejects.toThrow('cannot change inside a running transaction')
    })
  })

  it('opens a transaction of its own from an onCommit callback, once the outer one has settled', async () => {
    let followUp: Promise<unknown> | undefined

    await db.transaction(async (tx) => {
      tx.onCommit(() => {
        followUp = db.transaction(async inner => db.repo(usersTable).using(inner).write.insertOne({ name: 'Later', email: 'later@test.com' }, { pk: true }))
      })
    })

    await followUp

    expect(await db.repo(usersTable).read.count({ email: 'later@test.com' })).toBe(1)
  })
})
