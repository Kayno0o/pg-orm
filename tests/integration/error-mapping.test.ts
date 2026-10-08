import type { Database } from '../../src/index'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { AuthenticationError, ConnectionError, ExclusionError, ForeignKeyError, InvalidQueryError, NotNullError, TimeoutError, TransactionAbortedError, UniqueError } from '../../src/index'
import { createTestDb, TEST_URL } from '../helpers/db'

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [] })
  await db.raw('DROP TABLE IF EXISTS "em_child", "em_restrict", "em_parent", "em_ex"')
  await db.raw('CREATE TABLE "em_parent" ("id" int PRIMARY KEY, "email" text UNIQUE, "a" int, "Bee" int, UNIQUE ("a", "Bee"))')
  await db.raw('CREATE TABLE "em_child" ("id" int PRIMARY KEY, "parentId" int NOT NULL REFERENCES "em_parent" ("id"))')
  await db.raw('CREATE TABLE "em_restrict" ("id" int PRIMARY KEY, "parentId" int REFERENCES "em_parent" ("id") ON DELETE RESTRICT)')
  await db.raw('CREATE TABLE "em_ex" ("r" int4range, EXCLUDE USING gist ("r" WITH &&))')
  await db.raw('INSERT INTO "em_parent" VALUES (1, \'a@x\', 1, 1), (2, \'b@x\', 2, 2)')
  await db.raw('INSERT INTO "em_child" VALUES (1, 1)')
  await db.raw('INSERT INTO "em_restrict" VALUES (1, 2)')
  await db.raw('INSERT INTO "em_ex" VALUES (\'[1,5)\')')
})

afterAll(async () => {
  await db.raw('DROP TABLE IF EXISTS "em_child", "em_restrict", "em_parent", "em_ex"')
  await db.close({ timeout: 5000 })
})

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  }
  catch (err) {
    return err
  }

  throw new Error('expected a failure')
}

describe('error mapping on Postgres', () => {
  it('a foreign key error names the referencing and the referenced table, from either side', async () => {
    const insert = await caught(() => db.raw('INSERT INTO "em_child" VALUES (2, 99)'))
    const remove = await caught(() => db.raw('DELETE FROM "em_parent" WHERE "id" = 1'))
    const restrict = await caught(() => db.raw('DELETE FROM "em_parent" WHERE "id" = 2'))

    for (const [err, child] of [[insert, 'em_child'], [remove, 'em_child'], [restrict, 'em_restrict']] as const) {
      expect(err).toBeInstanceOf(ForeignKeyError)
      expect(err).toMatchObject({ table: child, referencedTable: 'em_parent' })
    }
  })

  it('a unique error names its columns', async () => {
    expect(await caught(() => db.raw('INSERT INTO "em_parent" VALUES (3, \'a@x\', 3, 3)'))).toMatchObject({ name: UniqueError.name, table: 'em_parent', column: 'email' })
    expect(await caught(() => db.raw('INSERT INTO "em_parent" VALUES (4, \'d@x\', 1, 1)'))).toMatchObject({ table: 'em_parent', column: 'a, Bee' })
  })

  it('a not-null error names its column', async () => {
    expect(await caught(() => db.raw('INSERT INTO "em_child" ("id") VALUES (5)'))).toMatchObject({ name: NotNullError.name, column: 'parentId' })
  })

  it('maps exclusion, aborted transaction, invalid query and lock timeout to typed errors', async () => {
    expect(await caught(() => db.raw('INSERT INTO "em_ex" VALUES (\'[3,8)\')'))).toBeInstanceOf(ExclusionError)
    expect(await caught(() => db.raw('SELECT * FROM "em_nope"'))).toMatchObject({ name: InvalidQueryError.name, code: '42P01' })
    expect(await caught(() => db.raw('SELEC 1'))).toMatchObject({ name: InvalidQueryError.name, code: '42601' })

    const aborted = await caught(() => db.transaction(async (tx) => {
      await caught(() => tx.query('SELECT * FROM "em_nope"', []))
      await tx.query('SELECT 1', [])
    }))

    expect(aborted).toBeInstanceOf(TransactionAbortedError)

    const locked = await caught(() => db.transaction(async (holder) => {
      await holder.query('LOCK TABLE "em_parent" IN ACCESS EXCLUSIVE MODE', [])
      await db.transaction({ independent: true }, async (tx) => {
        await tx.query('SET LOCAL lock_timeout = 50', [])
        await tx.query('SELECT * FROM "em_parent"', [])
      })
    }))

    expect(locked).toMatchObject({ name: TimeoutError.name, code: '55P03', table: 'em_parent' })
  })

  it('a timeout or connection error carries its query and table', async () => {
    const timeoutDb = createTestDb({ tables: [], statementTimeout: 50, retry: { maxRetries: 0 } })

    try {
      expect(await caught(() => timeoutDb.raw('SELECT pg_sleep(1), "id" FROM "em_parent"'))).toMatchObject({ name: TimeoutError.name, code: '57014', table: 'em_parent', query: 'SELECT pg_sleep(1), "id" FROM "em_parent"' })
    }
    finally {
      await timeoutDb.close()
    }

    const unreachable = createTestDb({ tables: [], url: 'postgres://test:test@10.255.255.1:5432/x', pool: { connectionTimeout: 1 }, retry: { maxRetries: 0 } })

    try {
      expect(await caught(() => unreachable.raw('SELECT * FROM "em_parent"'))).toMatchObject({ name: ConnectionError.name, table: 'em_parent' })
    }
    finally {
      await unreachable.close({ timeout: 0 })
    }
  })

  it('refused credentials are an AuthenticationError, not a retryable connection error', async () => {
    const badAuth = createTestDb({ tables: [], url: TEST_URL.replace('test:test@', 'test:wrong@') })

    try {
      const err = await caught(() => badAuth.raw('SELECT 1'))

      expect(err).toMatchObject({ name: AuthenticationError.name, code: '28P01' })
      expect(err).not.toBeInstanceOf(ConnectionError)
    }
    finally {
      await badAuth.close({ timeout: 0 })
    }
  })
})
