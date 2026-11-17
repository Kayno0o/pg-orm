import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { DialectError, ValidationError } from '../../../src/errors/index'
import { validateDbConfig } from '../../../src/sql/config'
import { SqliteDriver } from '../../../src/sql/sqlite-driver'

const dir = mkdtempSync(join(tmpdir(), 'pg-orm-sqlite-driver-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Cache = Map<string, unknown>

function cacheOf(driver: SqliteDriver): Cache {
  return (driver as unknown as { _statements: Cache })._statements
}

describe('SqliteDriver', () => {
  it('opens a file with synchronous NORMAL, or FULL when asked', async () => {
    const normal = new SqliteDriver(join(dir, 'normal.db'))
    const full = new SqliteDriver(join(dir, 'full.db'), 'full')

    try {
      expect(await normal.unsafe('PRAGMA synchronous', [])).toEqual([{ synchronous: 1 }])
      expect(await full.unsafe('PRAGMA synchronous', [])).toEqual([{ synchronous: 2 }])
    }
    finally {
      await normal.close()
      await full.close()
    }
  })

  it('keeps a statement under the SQL it was sent as, and runs a long one without keeping it', async () => {
    const driver = new SqliteDriver(':memory:')

    try {
      await driver.unsafe('CREATE TABLE t (n INTEGER)', [])
      cacheOf(driver).clear()

      expect(await driver.unsafe('SELECT $1 AS n', [1])).toEqual([{ n: 1 }])
      expect([...cacheOf(driver).keys()]).toEqual(['SELECT $1 AS n'])

      const values = Array.from({ length: 2000 }, (_, i) => `($${i + 1})`).join(', ')

      await driver.unsafe(`INSERT INTO t (n) VALUES ${values}`, Array.from({ length: 2000 }, (_, i) => i))
      expect(await driver.unsafe('SELECT count(*) AS c FROM t', [])).toEqual([{ c: 2000 }])
      expect(cacheOf(driver).size).toBe(2)
    }
    finally {
      await driver.close()
    }
  })
})

describe('DbConfig.sqlite', () => {
  it('takes normal or full on a SQLite url, and is refused on Postgres', () => {
    expect(() => validateDbConfig({ url: 'sqlite://:memory:', sqlite: { synchronous: 'full' } })).not.toThrow()
    expect(() => validateDbConfig({ url: 'sqlite://:memory:', sqlite: { synchronous: 'off' as 'full' } })).toThrow(ValidationError)
    expect(() => validateDbConfig({ url: 'postgres://localhost/x', sqlite: { synchronous: 'full' } })).toThrow(DialectError)
  })
})
