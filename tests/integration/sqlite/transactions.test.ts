import type { QueryEvent } from '../../../src/index'
import { describe, expect, it } from 'bun:test'
import { Database } from '../../../src/index'

async function memoryDb(onQuery?: (e: QueryEvent) => void): Promise<Database> {
  const db = new Database({ url: 'sqlite://:memory:', onQuery })

  await db.raw('CREATE TABLE t (v INTEGER)')

  return db
}

async function count(db: Database): Promise<number> {
  const [row] = await db.raw<{ n: number }>('SELECT count(*) AS n FROM t')

  return row!.n
}

describe('sqlite transactions', () => {
  it('a read-only transaction refuses writes, and later ones write again', async () => {
    const db = await memoryDb()

    await expect(db.transaction({ accessMode: 'read only' }, tx => tx.query('INSERT INTO t VALUES (1)', []))).rejects.toThrow()
    await db.transaction(tx => tx.query('INSERT INTO t VALUES (2)', []))

    expect(await count(db)).toBe(1)
    await db.close()
  })

  it('a committed transaction never reports a rollback, even when onCommit and onCallbackError both throw', async () => {
    const db = new Database({
      url: 'sqlite://:memory:',
      onCallbackError: () => {
        throw new Error('reporter down')
      },
    })
    const rollbacks: unknown[] = []
    const warn = console.warn

    console.warn = () => undefined

    try {
      await expect(db.transaction(async (tx) => {
        tx.onCommit(() => {
          throw new Error('commit callback failed')
        })
        tx.onRollback(err => void rollbacks.push(err))

        return 'done'
      })).resolves.toBe('done')
    }
    finally {
      console.warn = warn
    }

    expect(rollbacks).toEqual([])
    await db.close()
  })

  it('a transaction started by work outliving its body opens its own', async () => {
    const db = await memoryDb()
    const { promise: committed, resolve } = Promise.withResolvers<void>()
    let later!: Promise<unknown>

    await db.transaction(async () => {
      setTimeout(() => {
        later = db.transaction(async (tx) => {
          tx.onCommit(resolve)
          await tx.query('INSERT INTO t VALUES (1)', [])
        })
      }, 10)
    })
    await committed
    await later

    expect(await count(db)).toBe(1)
    await db.close()
  })

  it('a query from work outliving its transaction waits for the next one instead of running inside it', async () => {
    const db = await memoryDb()
    const { promise: gate, resolve: openGate } = Promise.withResolvers<void>()
    const { promise: written, resolve: wrote } = Promise.withResolvers<void>()

    await db.transaction(async () => {
      setTimeout(async () => {
        await gate
        await db.raw('INSERT INTO t VALUES (1)')
        wrote()
      }, 0)
    })

    await expect(db.transaction(async () => {
      openGate()
      await Bun.sleep(20)

      throw new Error('undo')
    })).rejects.toThrow('undo')
    await written

    expect(await count(db)).toBe(1)
    await db.close()
  })

  it('a query on a settled transaction client is refused', async () => {
    const db = await memoryDb()
    const tx = await db.transaction(async tx => tx)

    await expect(tx.query('INSERT INTO t VALUES (1)', [])).rejects.toThrow('already committed or rolled back')
    expect(await count(db)).toBe(0)
    await db.close()
  })

  it('savepoint() is a nested transaction: callbacks wait for the outer commit, the context carries over', async () => {
    const events: QueryEvent[] = []
    const db = await memoryDb(e => void events.push(e))
    const fired: string[] = []

    await db.transaction({ context: { requestId: 'r1' } }, async (tx) => {
      await tx.savepoint(async (sp) => {
        sp.onCommit(() => void fired.push('commit'))
        await sp.query('INSERT INTO t VALUES (1)', [])
      })
      expect(fired).toEqual([])
    })

    expect(fired).toEqual(['commit'])
    expect(events.find(e => e.sql.startsWith('INSERT'))?.context).toEqual({ requestId: 'r1' })
    await db.close()
  })
})
