import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { SqliteDriver } from '../../../src/sql/sqlite-driver'

type WaitBusy = <T>(fn: () => T) => Promise<T>

function busyError(code: string, errno: number): Error {
  return Object.assign(new Error('database is locked'), { code, errno })
}

function waitBusy(): WaitBusy {
  const driver = new SqliteDriver(':memory:') as unknown as { _waitBusy: WaitBusy }

  return driver._waitBusy.bind(driver)
}

describe('SqliteDriver busy wait', () => {
  for (const [code, errno] of [['SQLITE_BUSY', 5], ['SQLITE_BUSY_RECOVERY', 261], ['SQLITE_BUSY_SNAPSHOT', 517], ['SQLITE_BUSY_TIMEOUT', 773]] as const) {
    it(`retries ${code} until the statement runs`, async () => {
      let calls = 0
      const result = await waitBusy()(() => {
        if (++calls < 3)
          throw busyError(code, errno)

        return 'ran'
      })

      expect(result).toBe('ran')
      expect(calls).toBe(3)
    })
  }

  it('throws any other error at once', async () => {
    let calls = 0
    const run = waitBusy()(() => {
      calls++

      throw busyError('SQLITE_LOCKED', 6)
    })

    await expect(run).rejects.toThrow('database is locked')
    expect(calls).toBe(1)
  })
})

describe('SqliteDriver statement waiting on another process\'s lock', () => {
  it('runs after a transaction begun meanwhile, so that transaction\'s rollback keeps its row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-orm-busy-'))
    const file = join(dir, 'busy.db')
    const driver = new SqliteDriver(file)

    try {
      await driver.unsafe('CREATE TABLE t (n INTEGER)', [])
      const other = new Database(file)

      other.run('BEGIN IMMEDIATE')

      // The insert's backoff has grown to its longest by the time the transaction starts retrying, so the transaction takes the lock first.
      const insert = driver.unsafe('INSERT INTO t (n) VALUES (1)', [])

      await Bun.sleep(200)
      const failed = driver.begin(async () => {
        await Bun.sleep(300)

        throw new Error('rollback')
      })

      await Bun.sleep(5)
      other.run('COMMIT')
      other.close()

      await insert
      await expect(failed).rejects.toThrow('rollback')
      expect(await driver.unsafe('SELECT n FROM t', [])).toEqual([{ n: 1 }])
    }
    finally {
      await driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
