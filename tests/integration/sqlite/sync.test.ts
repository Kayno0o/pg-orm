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

    const before = open([authorsV1, books])

    await before.sync()
    await seed(before)
    await before.raw('INSERT INTO "authors" ("name") VALUES ($1)', ['Deleted'])
    await before.raw('DELETE FROM "authors" WHERE "name" = $1', ['Deleted'])

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

    // The foreign key still cascades, and the id deleted before the rebuild is not handed out again.
    await db.raw('DELETE FROM "authors" WHERE "id" = 1')

    expect(await db.raw('SELECT "title" FROM "books"')).toEqual([{ title: 'Cobol' }])
    expect(await db.raw('INSERT INTO "authors" ("name") VALUES ($1) RETURNING "id"', ['Linus'])).toEqual([{ id: 4 }])
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

  it('renames a table, keeping its rows, with an identity key, a UNIQUE over two columns and expression and descending indexes', async () => {
    const open = file()
    const before = defineTable('old_tags', t => ({ id: t.int4().primaryKey().identity(), a: t.text(), b: t.text() }))
      .withUnique(['a', 'b'])
      .withIndexes([{ columns: ['a'], desc: ['a'] }, { name: 'old_tags_lower_b', columns: [], expressions: ['lower("b")'] }])

    await open([before]).sync()
    await opened.at(-1)!.raw('INSERT INTO "old_tags" ("a", "b") VALUES ($1, $2)', ['x', 'y'])
    await expect(opened.at(-1)!.raw('INSERT INTO "old_tags" ("a", "b") VALUES ($1, $2)', ['x', 'y'])).rejects.toThrow()

    const after = defineTable('tags', t => ({ id: t.int4().primaryKey().identity(), a: t.text(), b: t.text() }))
      .withUnique(['a', 'b'])
      .withIndexes([{ columns: ['a'], desc: ['a'] }, { name: 'tags_lower_b', columns: [], expressions: ['lower("b")'] }])
      .renamedFrom('old_tags')
    const db = open([after])
    const { ops } = await db.sync()

    expect(ops.every(op => !op.destructive)).toBe(true)
    expect(await db.raw('SELECT "id", "a" FROM "tags"')).toEqual([{ id: 1, a: 'x' }])
    expect(await db.raw('INSERT INTO "tags" ("a", "b") VALUES ($1, $2) RETURNING "id"', ['z', 'y'])).toEqual([{ id: 2 }])
    expect((await db.sync()).ops).toEqual([])
  })

  it('adds a NOT NULL column without a default to a table with rows through its backfill value', async () => {
    const open = file()

    await open([authorsV1, books]).sync()
    await seed(opened.at(-1)!)

    const authorsV2 = defineTable('authors', t => ({ id: t.serial().primaryKey(), name: t.text(), country: t.text().backfill('unknown') }))
    const db = open([authorsV2, books])

    await db.sync()

    expect(await db.raw('SELECT "country" FROM "authors"')).toEqual([{ country: 'unknown' }, { country: 'unknown' }])
    expect(await db.raw('SELECT "dflt_value" AS "default" FROM pragma_table_info(\'authors\') WHERE "name" = \'country\'')).toEqual([{ default: null }])
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

  it('refuses to make a plain column generated without allowDestructive, its values then recomputed', async () => {
    const open = file()
    const plain = defineTable('nums', t => ({ id: t.serial().primaryKey(), a: t.int4(), b: t.int4() }))
    const computed = defineTable('nums', t => ({ id: t.serial().primaryKey(), a: t.int4(), b: t.int4().generated('"a" * 2') }))

    await open([plain]).sync()
    await opened.at(-1)!.raw('INSERT INTO "nums" ("a", "b") VALUES (1, 7)')

    const db = open([computed])

    await expect(db.sync()).rejects.toThrow(DestructiveOpError)

    const { ops } = await db.sync({ allowDestructive: true })

    expect(ops[0]!.description).toBe('Rebuild table "nums" (make "b" generated)')
    expect(await db.raw('SELECT "a", "b" FROM "nums"')).toEqual([{ a: 1, b: 2 }])
    expect((await open([computed]).sync()).ops).toEqual([])
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

  it('refuses to roll back a rebuild, which has no reverse, leaving the history as it was', async () => {
    const open = file()

    await open([authorsV1]).sync()

    const db = open([defineTable('authors', t => ({ id: t.serial().primaryKey(), name: t.text().unique() }))])

    await db.sync()

    await expect(db.rollback()).rejects.toThrow(MigrationError)
    expect((await getMigrationHistory(db)).map(m => m.direction)).toEqual(['up', 'up'])
  })

  it('refuses a migration from inside a transaction, which holds the one connection', async () => {
    const db = file()([authorsV1])

    await db.transaction(async () => {
      await expect(db.sync()).rejects.toThrow(DialectError)
    })
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

    const halves = defineTable('halves', t => ({ id: t.serial().primaryKey(), embedding: t.halfvec(3) }))
    const sparse = defineTable('sparse', t => ({ id: t.serial().primaryKey(), embedding: t.sparsevec(3) }))
    const indexed = defineTable('indexed', t => ({ id: t.serial().primaryKey(), n: t.int4().index({ method: 'hnsw', opclass: 'vector_l2_ops' }) }))

    await expect(file()([vectors]).sync()).rejects.toThrow(DialectError)
    await expect(file()([halves]).sync()).rejects.toThrow(DialectError)
    await expect(file()([sparse]).sync()).rejects.toThrow(DialectError)
    await expect(file()([indexed]).sync()).rejects.toThrow(DialectError)
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
