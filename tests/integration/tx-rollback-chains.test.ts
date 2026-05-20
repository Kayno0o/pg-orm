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

describe('Transaction rollback chains', () => {
  it('inner savepoint rollback + outer commit: only outer changes persist', async () => {
    await db.transaction(async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.insertOne({ name: 'Outer', email: 'outer@chain.test' })

      try {
        await tx.savepoint(async (sp) => {
          const spRepo = db.repo(usersTable).using(sp)

          await spRepo.insertOne({ name: 'Inner', email: 'inner@chain.test' })

          throw new Error('rollback inner')
        })
      }
      catch { /* swallowed */ }
    })

    const users = await db.repo(usersTable).findMany()

    expect(users).toHaveLength(1)
    expect(users[0]!.name).toBe('Outer')
  })

  it('inner savepoint commits + outer rolls back: nothing persists', async () => {
    try {
      await db.transaction(async (tx) => {
        const repo = db.repo(usersTable).using(tx)

        await repo.insertOne({ name: 'Outer', email: 'outer@chain.test' })
        await tx.savepoint(async (sp) => {
          const spRepo = db.repo(usersTable).using(sp)

          await spRepo.insertOne({ name: 'Inner', email: 'inner@chain.test' })
        })

        throw new Error('rollback outer')
      })
    }
    catch { /* swallowed */ }

    const count = await db.repo(usersTable).count()

    expect(count).toBe(0)
  })

  it('mixed: SP1 commits, SP2 rolls back, outer commits → only SP1 visible', async () => {
    await db.transaction(async (tx) => {
      await tx.savepoint(async (sp1) => {
        await db.repo(usersTable).using(sp1).insertOne({ name: 'SP1', email: 'sp1@chain.test' })
      })

      try {
        await tx.savepoint(async (sp2) => {
          await db.repo(usersTable).using(sp2).insertOne({ name: 'SP2', email: 'sp2@chain.test' })

          throw new Error('rollback sp2')
        })
      }
      catch { /* swallowed */ }
    })

    const users = await db.repo(usersTable).findMany(q => q.orderBy('name', 'asc'))

    expect(users).toHaveLength(1)
    expect(users[0]!.name).toBe('SP1')
  })

  it('onCommit fires once on tx commit, never for inner savepoints', async () => {
    const calls: string[] = []

    await db.transaction(async (tx) => {
      tx.onCommit(() => {
        calls.push('commit')
      })
      tx.onRollback(() => {
        calls.push('rollback')
      })

      await tx.savepoint(async (sp) => {
        await db.repo(usersTable).using(sp).insertOne({ name: 'X', email: 'x@chain.test' })
      })
    })

    expect(calls).toEqual(['commit'])
  })

  it('onRollback fires once on tx rollback, even when an inner savepoint already rolled back', async () => {
    const calls: string[] = []

    try {
      await db.transaction(async (tx) => {
        tx.onCommit(() => {
          calls.push('commit')
        })
        tx.onRollback(() => {
          calls.push('rollback')
        })

        try {
          await tx.savepoint(async (sp) => {
            await db.repo(usersTable).using(sp).insertOne({ name: 'X', email: 'x@chain.test' })

            throw new Error('sp boom')
          })
        }
        catch { /* swallowed */ }

        throw new Error('tx boom')
      })
    }
    catch { /* swallowed */ }

    expect(calls).toEqual(['rollback'])
  })

  it('error inside savepoint propagates up if uncaught', async () => {
    let outerCaught = false

    try {
      await db.transaction(async (tx) => {
        await tx.savepoint(async (sp) => {
          await db.repo(usersTable).using(sp).insertOne({ name: 'X', email: 'x@chain.test' })

          throw new Error('unhandled sp error')
        })
      })
    }
    catch {
      outerCaught = true
    }

    expect(outerCaught).toBe(true)

    const count = await db.repo(usersTable).count()

    expect(count).toBe(0)
  })
})
