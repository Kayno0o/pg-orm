import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'

const writers = defineTable('jn_writers', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
}))

const books = defineTable('jn_books', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
  writerId: t.int4().nullable(),
  stock: t.int4(),
  minStock: t.int4(),
}))

const tables = [writers, books]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-joins-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'joins.db')}`, tables })],
]

describe.each(dialects)('joined selects on %s', (_name, open) => {
  let db: Database

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    await db.raw('DELETE FROM "jn_books"')
    await db.raw('DELETE FROM "jn_writers"')

    const ann = await db.repo(writers).write.insertOne({ name: 'Ann' })
    const bob = await db.repo(writers).write.insertOne({ name: 'Bob' })

    await db.repo(books).write.insertMany([
      { name: 'Alpha', writerId: ann.id, stock: 1, minStock: 5 },
      { name: 'Beta', writerId: bob.id, stock: 9, minStock: 5 },
      { name: 'Gamma', writerId: null, stock: 5, minStock: 5 },
    ], { pk: true })
  })

  afterAll(async () => {
    await db.close()
  })

  it('runs with column names both tables share, filtering and ordering on either', async () => {
    const rows = await db.repo(books).read.findMany(q => q
      .join(writers, 'w', e => e.eq('writerId', e.ref('w.id')))
      .where({ 'w.name': 'Ann' })
      .orderBy('id')
      .pick('id', 'name', 'w.name'))
    const typed: { 'id': number, 'name': string, 'w.name': string }[] = rows

    expect(typed).toEqual([{ 'id': expect.any(Number), 'name': 'Alpha', 'w.name': 'Ann' }])
  })

  it('returns only the table\'s own columns when nothing is picked', async () => {
    const rows = await db.repo(books).read.findMany(q => q.join(writers, 'w', e => e.eq('writerId', e.ref('w.id'))).orderBy('w.name'))

    expect(rows.map(r => r.name)).toEqual(['Alpha', 'Beta'])
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'minStock', 'name', 'stock', 'writerId'])
  })

  it('types a left join\'s columns as nullable', async () => {
    const rows = await db.repo(books).read.findMany(q => q
      .leftJoin(writers, 'w', e => e.eq('writerId', e.ref('w.id')))
      .orderBy('name')
      .pick('name', 'w.name'))
    const typed: { 'name': string, 'w.name': string | null }[] = rows

    expect(typed.map(r => r['w.name'])).toEqual(['Ann', 'Bob', null])
  })

  it('compares two columns of a row without raw SQL', async () => {
    const low = await db.repo(books).read.findMany(q => q.where(e => e.lt('stock', e.ref('minStock'))))
    const atMin = await db.repo(books).read.findMany(q => q.where(e => e.eq('stock', e.ref('minStock'))))

    expect(low.map(r => r.name)).toEqual(['Alpha'])
    expect(atMin.map(r => r.name)).toEqual(['Gamma'])
  })

  it('rejects a joined column the table def does not have, at compile time', () => {
    // @ts-expect-error writers has no column "title"
    const typed = () => db.repo(books).read.findMany(q => q.join(writers, 'w', e => e.eq('w.title', 'x')))

    expect(typeof typed).toBe('function')
  })
})
