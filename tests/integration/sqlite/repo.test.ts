import type { InferEntity } from '../../../src/index'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { CheckError, ConnectionError, Database, defineTable, DialectError, ForeignKeyError, NotNullError, optimisticLock, softDelete, timestamps, UniqueError, ValidationError } from '../../../src/index'

const authors = defineTable('authors', t => ({
  id: t.serial().primaryKey(),
  name: t.text().unique(),
  email: t.text().nullable(),
  active: t.bool().default(true),
  rank: t.int4().min(0).default(0),
}))
  .withTrait(softDelete())
  .withTrait(timestamps())

const booksDef = defineTable('books', t => ({
  id: t.uuid().primaryKey().defaultRaw('gen_random_uuid()'),
  title: t.text(),
  authorId: t.int4().references(() => authors, 'id', { onDelete: 'cascade' }),
  tags: t.array(t.text()).default([]),
  meta: t.jsonb<{ pages: number }>().nullable(),
  price: t.numeric(10, 2).nullable(),
  sales: t.bigint().default(0n),
  publishedAt: t.timestamptz().nullable(),
  cover: t.bytea().nullable(),
}))
  .withTrait(optimisticLock())

const shelves = defineTable('shelves', t => ({
  id: t.serial().primaryKey(),
  label: t.text(),
}))

const shelfBooks = defineTable('shelf_books', t => ({
  shelfId: t.int4().primaryKey(),
  bookId: t.uuid().primaryKey(),
}))

const authorsTable = authors.withRelations(r => ({
  books: r.hasMany<InferEntity<typeof booksDef>>('books', 'authorId'),
}))

const books = booksDef.withRelations(r => ({
  author: r.belongsTo(() => authorsTable, 'authorId'),
  shelves: r.hasManyThrough(() => shelves, () => shelfBooks, { from: 'bookId', to: 'shelfId' }),
}))

const noop = async (): Promise<void> => undefined
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-sqlite-'))
let db: Database

beforeAll(async () => {
  db = new Database({ url: `sqlite://${join(dir, 'app.db')}`, tables: [authorsTable, books, shelves, shelfBooks] })
  await db.sync()
})

beforeEach(async () => {
  for (const table of ['shelf_books', 'shelves', 'books', 'authors'])
    await db.raw(`DELETE FROM "${table}"`)
})

afterAll(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('SQLite repositories', () => {
  it('opens a file database in WAL mode with foreign keys on', async () => {
    expect(db.dialect).toBe('sqlite')
    expect(await db.raw('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }])
    expect(await db.raw('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
  })

  it('inserts, finds, updates and deletes', async () => {
    const repo = db.repo(authorsTable)
    const id = await repo.write.insertOne({ name: 'Ada' })
    const ada = await repo.read.findByIdOrThrow(id)

    expect(ada).toMatchObject({ name: 'Ada', email: null, active: true, rank: 0, deletedAt: null })
    expect(ada.createdAt).toBeInstanceOf(Date)

    await repo.write.updateById(id, { email: 'ada@example.com', active: false })

    expect(await repo.read.findById(id)).toMatchObject({ email: 'ada@example.com', active: false })
    expect(await repo.write.deleteById(id)).toBe(id)
    expect(await repo.read.findById(id)).toBeNull()
  })

  it('round-trips every column type it stores', async () => {
    const authorId = await db.repo(authorsTable).write.insertOne({ name: 'Grace' })
    const publishedAt = new Date('2024-05-01T10:20:30.456Z')
    const big = 9223372036854775807n
    const id = await db.repo(books).write.insertOne({
      title: 'Compilers',
      authorId,
      tags: ['cs', 'it\'s'],
      meta: { pages: 412 },
      price: '19.90',
      sales: big,
      publishedAt,
      cover: new Uint8Array([1, 2, 3]),
    })
    const book = await db.repo(books).read.findByIdOrThrow(id)

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(book.tags).toEqual(['cs', 'it\'s'])
    expect(book.meta).toEqual({ pages: 412 })
    expect(book.price).toBe('19.9')
    expect(book.sales).toBe(big)
    expect(book.publishedAt).toEqual(publishedAt)
    expect(new Uint8Array(book.cover!)).toEqual(new Uint8Array([1, 2, 3]))
    expect(book.version).toBe(1)
  })

  it('fills the defaults of a multi-row insert, which SQLite has no DEFAULT keyword for', async () => {
    const ids = await db.repo(authorsTable).write.insertMany([{ name: 'A' }, { name: 'B', rank: 3 }])
    const rows = await db.repo(authorsTable).read.findMany(q => q.orderBy('id'))

    expect(ids[1]).toBe(ids[0]! + 1)
    expect(rows.map(r => [r.name, r.active, r.rank])).toEqual([['A', true, 0], ['B', true, 3]])
  })

  it('filters like Postgres: like is case-sensitive, ilike is not, arrays are searched', async () => {
    const authorId = await db.repo(authorsTable).write.insertOne({ name: 'Linus' })

    await db.repo(books).write.insertMany([
      { title: 'Alpha_1', authorId, tags: ['a', 'b'] },
      { title: 'alpha*2', authorId, tags: ['c'] },
    ])

    const repo = db.repo(books)
    const titles = async (rows: Promise<{ title: string }[]>) => (await rows).map(b => b.title).sort()

    expect(await titles(repo.read.findMany(q => q.where(e => e.like('title', 'Alpha%'))))).toEqual(['Alpha_1'])
    expect(await titles(repo.read.findMany(q => q.where(e => e.ilike('title', 'alpha%'))))).toEqual(['Alpha_1', 'alpha*2'])
    expect(await titles(repo.read.findMany(q => q.where(e => e.like('title', '%\\_%'))))).toEqual(['Alpha_1'])
    expect(await titles(repo.read.findMany(q => q.where(e => e.like('title', '%*%'))))).toEqual(['alpha*2'])
    expect(await titles(repo.read.findMany(q => q.where(e => e.arrayContains('tags', 'b'))))).toEqual(['Alpha_1'])
    expect(await titles(repo.read.findMany(q => q.where(e => e.arrayOverlap('tags', ['c', 'z']))))).toEqual(['alpha*2'])
    expect(await titles(repo.read.findMany(q => q.where({ title: { in: ['Alpha_1'] } })))).toEqual(['Alpha_1'])
  })

  it('loads belongsTo, hasMany and hasManyThrough relations, and counts children', async () => {
    const authorId = await db.repo(authorsTable).write.insertOne({ name: 'Knuth' })
    const [first, second] = await db.repo(books).write.insertMany([{ title: 'TAOCP 1', authorId }, { title: 'TAOCP 2', authorId }])
    const shelfId = await db.repo(shelves).write.insertOne({ label: 'Classics' })

    await db.repo(shelfBooks).write.insertOne({ shelfId, bookId: first! })

    const [book] = await db.repo(books).read.findMany(q => q.include('author').include('shelves').where({ id: first! }))
    const [author] = await db.repo(authorsTable).read.findMany(q => q.include('books').withCount('books'))

    expect(book!.author!.name).toBe('Knuth')
    expect(book!.shelves.map(s => String(s.label))).toEqual(['Classics'])
    expect(author!.books.map(b => b.id).sort()).toEqual([first!, second!].sort())
    expect(author!.booksCount).toBe(2)
  })

  it('paginates, by page and by cursor, and streams', async () => {
    await db.repo(shelves).write.insertMany(Array.from({ length: 7 }, (_, i) => ({ label: `s${i}` })))

    const page = await db.repo(shelves).read.paginate({ page: 2, perPage: 3 })
    const first = await db.repo(shelves).read.paginateCursor({ column: 'id', take: 3 })
    const cursor = await db.repo(shelves).read.paginateCursor({ column: 'id', take: 3, cursor: first.nextCursor })
    const streamed: string[] = []

    for await (const row of db.repo(shelves).stream.stream(q => q.orderBy('id'), { chunkSize: 2, unsafe: true }))
      streamed.push(row.label)

    expect(page.total).toBe(7)
    expect(page.data.map(r => r.label)).toEqual(['s3', 's4', 's5'])
    expect(cursor.data.map(r => r.label)).toEqual(['s3', 's4', 's5'])
    expect(streamed).toHaveLength(7)
  })

  it('upserts, findOrCreate leaving the existing row untouched', async () => {
    const repo = db.repo(authorsTable)
    const id = await repo.write.upsertOne({ name: 'Ken', rank: 1 }, ['name'])

    expect(await repo.write.upsertOne({ name: 'Ken', rank: 5 }, ['name'])).toBe(id)
    expect((await repo.read.findByIdOrThrow(id)).rank).toBe(5)
    expect(await repo.write.findOrCreate({ name: 'Ken', rank: 9 }, ['name'])).toBe(id)
    expect((await repo.read.findByIdOrThrow(id)).rank).toBe(5)
    expect(await repo.write.upsertMany([{ name: 'Ken', rank: 6 }, { name: 'Rob' }], ['name'])).toHaveLength(2)
  })

  it('soft-deletes and restores, and bumps the version of an optimistic lock', async () => {
    const authorId = await db.repo(authorsTable).write.insertOne({ name: 'Dennis' })

    await db.repo(authorsTable).write.deleteById(authorId)

    expect(await db.repo(authorsTable).read.count()).toBe(0)
    expect(await db.repo(authorsTable).read.count(undefined, { withTrashed: true })).toBe(1)

    await db.repo(authorsTable).write.restore({ id: authorId })

    const bookId = await db.repo(books).write.insertOne({ title: 'C', authorId })

    await db.repo(books).write.updateWithLock({ title: 'The C Programming Language' }, { id: bookId }, 1)

    expect((await db.repo(books).read.findByIdOrThrow(bookId)).version).toBe(2)
    await expect(db.repo(books).write.updateWithLock({ title: 'stale' }, { id: bookId }, 1)).rejects.toThrow()
  })

  it('updates many rows by id in one statement', async () => {
    const [a, b] = await db.repo(authorsTable).write.insertMany([{ name: 'a' }, { name: 'b' }])

    await db.repo(authorsTable).write.updateManyById([{ id: a!, rank: 10 }, { id: b!, rank: 20 }])

    expect((await db.repo(authorsTable).read.findMany(q => q.orderBy('id'))).map(r => r.rank)).toEqual([10, 20])
  })
})

describe('SQLite single-row writes', () => {
  it('updateOne and deleteOne reach one of several matches, a composite key included', async () => {
    const [a, b] = await db.repo(authorsTable).write.insertMany([{ name: 'A', rank: 1 }, { name: 'B', rank: 1 }])
    const authorId = a!
    const [first, second] = await db.repo(books).write.insertMany([{ title: 'One', authorId }, { title: 'Two', authorId }])
    const shelfId = await db.repo(shelves).write.insertOne({ label: 'S' })

    await db.repo(shelfBooks).write.insertMany([{ shelfId, bookId: first! }, { shelfId, bookId: second! }])

    expect(await db.repo(authorsTable).write.updateOne({ rank: 2 }, { rank: 1 })).toBe(a!)
    expect((await db.repo(authorsTable).read.findById(b!))?.rank).toBe(1)
    expect(await db.repo(shelfBooks).write.deleteOne({ shelfId })).toEqual({ shelfId, bookId: [first!, second!].sort()[0]! })
    expect(await db.repo(shelfBooks).read.count({ shelfId })).toBe(1)
  })
})

describe('SQLite constraint errors', () => {
  it('maps each violation onto the typed error, named as Postgres would name it', async () => {
    const repo = db.repo(authorsTable)

    await repo.write.insertOne({ name: 'Ada' })

    await expect(repo.write.insertOne({ name: 'Ada' })).rejects.toMatchObject({ name: UniqueError.name, table: 'authors', constraint: 'authors_name_key' })
    await expect(repo.write.insertOne({ name: 'Ada' })).rejects.toThrow(UniqueError)
    await expect(db.raw('INSERT INTO "authors" ("name", "rank") VALUES ($1, $2)', ['Neg', -1])).rejects.toThrow(CheckError)
    await expect(db.raw('INSERT INTO "authors" ("rank") VALUES (1)')).rejects.toThrow(NotNullError)
    await expect(db.repo(books).write.insertOne({ title: 'Orphan', authorId: 999 })).rejects.toThrow(ForeignKeyError)
  })

  it('cascades a delete along a foreign key', async () => {
    const authorId = await db.repo(authorsTable).write.insertOne({ name: 'Gone' })

    await db.repo(books).write.insertOne({ title: 'Left behind', authorId })
    await db.repo(authorsTable).write.forceDelete({ id: authorId })

    expect(await db.repo(books).read.count()).toBe(0)
  })
})

describe('SQLite transactions', () => {
  it('commits, rolls back, and rolls a savepoint back alone', async () => {
    await db.transaction(async tx => void await db.repo(shelves).using(tx).write.insertOne({ label: 'kept' }))
    await expect(db.transaction(async (tx) => {
      await db.repo(shelves).using(tx).write.insertOne({ label: 'dropped' })

      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    await db.transaction(async (tx) => {
      await db.repo(shelves).using(tx).write.insertOne({ label: 'outer' })
      await expect(tx.savepoint(async (sp) => {
        await db.repo(shelves).using(sp).write.insertOne({ label: 'inner' })

        throw new Error('rollback the savepoint')
      })).rejects.toThrow('rollback the savepoint')
    })

    expect((await db.repo(shelves).read.findMany(q => q.orderBy('id'))).map(r => r.label)).toEqual(['kept', 'outer'])
  })

  it('runs transactions one at a time, a statement outside waiting for the one running', async () => {
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = db.transaction(async (tx) => {
      await db.repo(shelves).using(tx).write.insertOne({ label: 'first' })
      await held
      order.push('first committed')
    })
    const second = db.transaction(async (tx) => {
      order.push('second started')
      await db.repo(shelves).using(tx).write.insertOne({ label: 'second' })
    })
    const outside = (async () => {
      order.push(`outside saw ${await db.repo(shelves).read.count()}`)
    })()

    await Bun.sleep(10)
    release()
    await Promise.all([first, second, outside])

    expect(order).toEqual(['first committed', 'second started', 'outside saw 2'])
  })

  it('joins the running transaction from inside its body, and refuses an independent one there', async () => {
    await db.transaction(async () => {
      await db.repo(shelves).write.insertOne({ label: 'joined' })
      await db.transaction(async tx => void await db.repo(shelves).using(tx).write.insertOne({ label: 'nested' }))

      await expect(db.transaction({ independent: true }, noop)).rejects.toThrow(DialectError)
    })

    expect(await db.repo(shelves).read.count()).toBe(2)
  })

  it('checks an isolation level though SQLite is always serializable', async () => {
    await expect(db.transaction({ isolation: 'snapshot' as 'serializable' }, noop)).rejects.toThrow(ValidationError)
    await db.transaction({ isolation: 'read committed' }, noop)
  })
})

describe('SQLite shutdown', () => {
  function closable(name: string): Database {
    return new Database({ url: `sqlite://${join(dir, `${name}.db`)}`, tables: [shelves] })
  }

  it('close() gives a long transaction no more than its timeout, then fails what it runs next', async () => {
    const own = closable('close-timeout')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    await own.sync()

    const running = own.transaction(async (tx) => {
      await held
      await own.repo(shelves).using(tx).write.insertOne({ label: 'too late' })
    })

    await Bun.sleep(10)

    const started = performance.now()

    await own.close({ timeout: 100 })

    expect(performance.now() - started).toBeLessThan(1000)
    release()
    await expect(running).rejects.toBeInstanceOf(ConnectionError)
  })

  it('close({ drain }) lets a transaction begun before it run its pool queries', async () => {
    const own = closable('drain-nested')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    await own.sync()

    const running = own.transaction(async () => {
      await held

      return own.repo(shelves).write.insertOne({ label: 'during drain' })
    })

    await Bun.sleep(10)

    const closing = own.close({ drain: true, timeout: 5000 })

    release()
    expect(await running).toBe(1)
    await closing
  })
})

describe('SQLite process shutdown', () => {
  it('lets an app\'s own SIGTERM drain run to completion, the library never exiting the process', async () => {
    const script = `
      import { Database, defineTable } from ${JSON.stringify(join(import.meta.dir, '../../../src/index.ts'))}
      const t = defineTable('t', c => ({ id: c.serial().primaryKey() }))
      const db = new Database({ url: ${JSON.stringify(`sqlite://${join(dir, 'signal.db')}`)}, tables: [t] })
      await db.sync()
      process.on('SIGTERM', async () => {
        await db.close({ drain: true, timeout: 5000 })
        console.log('drained')
        process.exit(0)
      })
      void db.transaction(async () => {
        console.log('ready')
        await Bun.sleep(300)
        await db.repo(t).write.insertOne({})
        console.log('committed')
      })
      await Bun.sleep(5000)
    `
    const child = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let out = ''

    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      out += decoder.decode(chunk.value)

      if (out.includes('ready') && !child.killed)
        child.kill('SIGTERM')
    }

    expect(await child.exited).toBe(0)
    expect(out).toContain('committed\ndrained')
  })
})
