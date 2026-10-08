import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { CheckError, Database, ForeignKeyError, UniqueError } from '../../../src/index'

const db = new Database({ url: 'sqlite://:memory:' })

beforeAll(async () => {
  await db.raw('CREATE TABLE "parent" ("id" INTEGER PRIMARY KEY, "a" INTEGER, "b" INTEGER, "n" INTEGER CHECK ("n" > 0), UNIQUE ("a", "b"))')
  await db.raw('CREATE TABLE "child" ("id" INTEGER PRIMARY KEY, "parentId" INTEGER REFERENCES "parent" ("id"))')
  await db.raw('INSERT INTO "parent" VALUES (1, 1, 1, 1)')
  await db.raw('INSERT INTO "child" VALUES (1, 1)')
})

afterAll(async () => {
  await db.close()
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

describe('error mapping on SQLite', () => {
  it('a foreign key error names the table the statement wrote, on the side it broke', async () => {
    expect(await caught(() => db.raw('INSERT INTO "child" VALUES (2, 99)'))).toMatchObject({ name: ForeignKeyError.name, table: 'child', referencedTable: '' })
    expect(await caught(() => db.raw('DELETE FROM "parent" WHERE "id" = 1'))).toMatchObject({ name: ForeignKeyError.name, table: '', referencedTable: 'parent' })
  })

  it('a check error names its table, and a composite unique error its columns', async () => {
    expect(await caught(() => db.raw('INSERT INTO "parent" VALUES (2, 2, 2, 0)'))).toMatchObject({ name: CheckError.name, table: 'parent' })
    expect(await caught(() => db.raw('INSERT INTO "parent" VALUES (3, 1, 1, 1)'))).toMatchObject({ name: UniqueError.name, table: 'parent', column: 'a, b', constraint: 'parent_a_b_key' })
  })

  it('any query error carries the table its statement targets', async () => {
    expect(await caught(() => db.raw('SELECT nope FROM "parent"'))).toMatchObject({ table: 'parent' })
  })
})
