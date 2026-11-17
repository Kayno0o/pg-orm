import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { CheckError, Database, defineTable, ForeignKeyError, UniqueError } from '../../../src/index'

const db = new Database({ url: 'sqlite://:memory:' })

beforeAll(async () => {
  await db.raw('CREATE TABLE "parent" ("id" INTEGER PRIMARY KEY, "a" INTEGER, "b" INTEGER, "n" INTEGER CHECK ("n" > 0), UNIQUE ("a", "b"))')
  await db.raw('CREATE TABLE "child" ("id" INTEGER PRIMARY KEY, "parentId" INTEGER REFERENCES "parent" ("id"))')
  await db.raw('CREATE TABLE "named" ("id" INTEGER PRIMARY KEY, "a" TEXT, "b" TEXT, "c" TEXT, "email" TEXT, CONSTRAINT "uq_ab_custom" UNIQUE ("a", "b"))')
  await db.raw('CREATE UNIQUE INDEX "ix_c_unique" ON "named" ("c")')
  await db.raw('CREATE UNIQUE INDEX "named_lower_email" ON "named" (lower("email"))')
  await db.raw('INSERT INTO "named" VALUES (1, \'a\', \'b\', \'c\', \'e\')')
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

  it('a unique error names an explicit constraint or index as Postgres does', async () => {
    expect(await caught(() => db.raw('INSERT INTO "named" VALUES (2, \'a\', \'b\', \'x\', \'y\')'))).toMatchObject({ name: UniqueError.name, table: 'named', column: 'a, b', constraint: 'uq_ab_custom' })
    expect(await caught(() => db.raw('INSERT INTO "named" VALUES (3, \'x\', \'y\', \'c\', \'z\')'))).toMatchObject({ name: UniqueError.name, table: 'named', column: 'c', constraint: 'ix_c_unique' })
  })

  it('a unique expression index error names the table and the index', async () => {
    expect(await caught(() => db.raw('INSERT INTO "named" VALUES (4, \'p\', \'q\', \'r\', \'E\')'))).toMatchObject({ name: UniqueError.name, table: 'named', column: '', constraint: 'named_lower_email' })
  })

  it('names the constraints a table definition declares, as sync created them', async () => {
    const declared = defineTable('declared', t => ({ id: t.serial().primaryKey(), a: t.text(), b: t.text(), c: t.text().nullable() }))
      .withUnique(['a', 'b'], 'uq_ab_custom')
      .withIndexes([{ name: 'ix_c_unique', columns: ['c'], unique: true }])
    const synced = new Database({ url: 'sqlite://:memory:', tables: [declared] })

    try {
      await synced.sync()
      await synced.repo(declared).write.insertOne({ a: '1', b: '2', c: 'x' })

      expect(await caught(() => synced.repo(declared).write.insertOne({ a: '1', b: '2' }))).toMatchObject({ constraint: 'uq_ab_custom', table: 'declared' })
      expect(await caught(() => synced.repo(declared).write.insertOne({ a: '3', b: '4', c: 'x' }))).toMatchObject({ constraint: 'ix_c_unique', table: 'declared' })
    }
    finally {
      await synced.close()
    }
  })

  it('any query error carries the table its statement targets', async () => {
    expect(await caught(() => db.raw('SELECT nope FROM "parent"'))).toMatchObject({ table: 'parent' })
  })
})
