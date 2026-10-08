import type { AnyTableDef } from '../../../src/index'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { applyMigration, Database, defineTable, DestructiveOpError, DialectError, generateMigration, getMigrationHistory, getMigrationStatus, MigrationError, testDatabase } from '../../../src/index'

const dir = mkdtempSync(join(tmpdir(), 'pg-orm-sqlite-sync-'))
const opened: Database[] = []
let count = 0

// A database file of its own, opened again with each version of the schema a test moves through.
function file(): (tables: AnyTableDef[]) => Database {
  const url = `sqlite://${join(dir, `db${count++}.db`)}`

  return (tables) => {
    const db = new Database({ url, tables })

    opened.push(db)

    return db
  }
}

afterAll(async () => {
  for (const db of opened)
    await db.close()

  rmSync(dir, { recursive: true, force: true })
})

const authorsV1 = defineTable('authors', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
}))

const books = defineTable('books', t => ({
  id: t.serial().primaryKey(),
  title: t.text(),
  authorId: t.int4().references(() => authorsV1, 'id', { onDelete: 'cascade' }),
})).withIndexes([{ columns: ['title'] }])

async function seed(db: Database): Promise<void> {
  await db.raw('INSERT INTO "authors" ("name") VALUES ($1), ($2)', ['Ada', 'Grace'])
  await db.raw('INSERT INTO "books" ("title", "authorId") VALUES ($1, 1), ($2, 2)', ['Notes', 'Cobol'])
}

describe('sync() on SQLite', () => {
  it('creates the tables and their indexes, then finds nothing left to do', async () => {
    const open = file()
    const db = open([authorsV1, books])
    const { ops } = await db.sync()

    expect(ops.map(op => op.type)).toEqual(['create_table', 'create_table', 'create_index'])
    expect((await db.sync()).ops).toEqual([])
    expect(await getMigrationHistory(db)).toHaveLength(1)
  })

  it('adds a column and renames one in place, keeping the rows', async () => {
    const open = file()

    await open([authorsV1, books]).sync()
    await seed(opened.at(-1)!)

    const authorsV2 = defineTable('authors', t => ({
      id: t.serial().primaryKey(),
      fullName: t.text().renamedFrom('name'),
      bio: t.text().nullable(),
      score: t.int4().default(0),
    }))
    const db = open([authorsV2, books])
    const { ops } = await db.sync()

    expect(ops.map(op => op.type)).toEqual(['rename_column', 'add_column', 'add_column'])
    expect(await db.raw('SELECT "fullName", "bio", "score" FROM "authors" ORDER BY "id"')).toEqual([
      { fullName: 'Ada', bio: null, score: 0 },
      { fullName: 'Grace', bio: null, score: 0 },
    ])
    expect((await db.sync()).ops).toEqual([])
  })

  it('rebuilds a table ALTER cannot change, keeping its rows and the rows pointing at it', async () => {
    const open = file()

    await open([authorsV1, books]).sync()
    await seed(opened.at(-1)!)

    const authorsV2 = defineTable('authors', t => ({
      id: t.serial().primaryKey(),
      name: t.text().unique(),
      born: t.int4().min(1800).nullable(),
    }))
    const db = open([authorsV2, books])
    const { ops } = await db.sync()

    expect(ops.map(op => op.type)).toEqual(['rebuild_table'])
    expect(ops[0]!.destructive).toBe(false)
    expect(await db.raw('SELECT "id", "name" FROM "authors" ORDER BY "id"')).toEqual([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }])
    expect(await db.raw('SELECT count(*) AS "n" FROM "books"')).toEqual([{ n: 2 }])
    expect((await db.sync()).ops).toEqual([])

    // The foreign key still cascades, and the rowid still counts on from where it was.
    await db.raw('DELETE FROM "authors" WHERE "id" = 1')

    expect(await db.raw('SELECT "title" FROM "books"')).toEqual([{ title: 'Cobol' }])
    expect(await db.raw('INSERT INTO "authors" ("name") VALUES ($1) RETURNING "id"', ['Linus'])).toEqual([{ id: 3 }])
  })

  it('rebuilds a table whose indexes are recreated with it', async () => {
    const open = file()

    await open([authorsV1, books]).sync()

    const booksV2 = defineTable('books', t => ({
      id: t.serial().primaryKey(),
      title: t.text(),
      authorId: t.int4().references(() => authorsV1, 'id', { onDelete: 'set null' }).nullable(),
    })).withIndexes([{ columns: ['title'] }])
    const db = open([authorsV1, booksV2])
    const { ops } = await db.sync()

    expect(ops.map(op => op.type)).toEqual(['rebuild_table', 'create_index'])
    expect((await db.sync()).ops).toEqual([])
  })

  it('asks before dropping a column or changing its type, and rebuilds when told', async () => {
    const open = file()

    await open([authorsV1, books]).sync()
    await seed(opened.at(-1)!)

    const booksV2 = defineTable('books', t => ({
      id: t.serial().primaryKey(),
      title: t.int4().nullable(),
    })).withIndexes([{ columns: ['title'] }])
    const db = open([authorsV1, booksV2])

    await expect(db.sync()).rejects.toThrow(DestructiveOpError)

    const { ops } = await db.sync({ allowDestructive: true })

    expect(ops[0]!.description).toBe('Rebuild table "books" (drop "authorId", retype "title")')
    expect(await db.raw('SELECT "id" FROM "books" ORDER BY "id"')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('drops and recreates an index that changed, and drops one no longer declared', async () => {
    const open = file()

    await open([authorsV1, books]).sync()

    const booksV2 = defineTable('books', t => ({
      id: t.serial().primaryKey(),
      title: t.text(),
      authorId: t.int4().references(() => authorsV1, 'id', { onDelete: 'cascade' }),
    })).withIndexes([{ columns: ['title'], unique: true, name: 'books_title_idx' }, { columns: ['authorId'] }])
    const db = open([authorsV1, booksV2])
    const { ops } = await db.sync({ allowDestructive: true })

    expect(ops.map(op => op.description)).toEqual([
      'Drop index "books_title_idx" from "books" (changed)',
      'Recreate index "books_title_idx" on "books" (title)',
      'Create index "books_authorId_idx" on "books" (authorId)',
    ])
    expect((await db.sync()).ops).toEqual([])
  })

  it('rolls a migration back', async () => {
    const open = file()

    await open([authorsV1]).sync()

    const authorsV2 = defineTable('authors', t => ({
      id: t.serial().primaryKey(),
      name: t.text(),
      bio: t.text().nullable(),
    }))
    const db = open([authorsV2])

    await db.sync()

    const { rolledBack } = await db.rollback()

    expect(rolledBack).toHaveLength(1)
    expect((await db.raw<{ name: string }>('SELECT "name" FROM pragma_table_info(\'authors\')')).map(c => c.name)).toEqual(['id', 'name'])
  })

  it('generates a migration file, applies it and reports no drift after', async () => {
    const db = file()([authorsV1, books])
    const migration = await generateMigration(db, new Map<string, AnyTableDef>([['authors', authorsV1], ['books', books]]))

    expect((await getMigrationStatus(db, new Map<string, AnyTableDef>([['authors', authorsV1]]))).hasDrift).toBe(true)

    await applyMigration(db, migration!.up)

    expect((await getMigrationStatus(db, new Map<string, AnyTableDef>([['authors', authorsV1], ['books', books]]))).hasDrift).toBe(false)
  })

  it('refuses a migration leaving rows that break a foreign key', async () => {
    const db = file()([authorsV1, books])

    await db.sync()
    await seed(db)

    await expect(applyMigration(db, 'DELETE FROM "authors"; DROP TABLE "authors"; CREATE TABLE "authors" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)')).rejects.toThrow(MigrationError)
    expect(await db.raw('SELECT count(*) AS "n" FROM "authors"')).toEqual([{ n: 2 }])
  })

  it('names what SQLite cannot hold', async () => {
    const vectors = defineTable('vectors', t => ({ id: t.serial().primaryKey(), embedding: t.vector(3) }))
    const patterns = defineTable('patterns', t => ({ id: t.serial().primaryKey(), code: t.text().pattern('^[A-Z]+$') }))

    await expect(file()([vectors]).sync()).rejects.toThrow(DialectError)
    await expect(file()([patterns]).sync()).rejects.toThrow(DialectError)
  })
})

describe('testDatabase on SQLite', () => {
  it('copies a migrated, seeded template file for each caller, and drops the copy with its WAL files', async () => {
    const migrationsDir = mkdtempSync(join(tmpdir(), 'pg-orm-sqlite-migrations-'))

    writeFileSync(join(migrationsDir, '0001_member.sql'), '-- migrate:up\nCREATE TABLE member (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\n\n-- migrate:down\nDROP TABLE member;\n')

    try {
      const options = { url: `sqlite://${join(dir, 'tdb', 'app.db')}`, migrationsDir, seed: async (db: Database) => void await db.raw('INSERT INTO member (name) VALUES ($1)', ['Ada']) }
      const [first, second] = await Promise.all([testDatabase(options), testDatabase(options)])
      const a = new Database({ url: first.url })
      const b = new Database({ url: second.url })

      await a.raw('INSERT INTO member (name) VALUES ($1)', ['Grace'])

      expect(await a.raw('SELECT name FROM member ORDER BY id')).toEqual([{ name: 'Ada' }, { name: 'Grace' }])
      expect(await b.raw('SELECT name FROM member ORDER BY id')).toEqual([{ name: 'Ada' }])
      expect(await getMigrationHistory(b)).toMatchObject([{ name: '0001_member', direction: 'up' }])

      await a.close()
      await b.close()
      await first.drop()
      await second.drop()

      expect(readdirSync(join(dir, 'tdb')).filter(f => !f.includes('_tpl_'))).toEqual([])
    }
    finally {
      rmSync(migrationsDir, { recursive: true, force: true })
    }
  })
})
