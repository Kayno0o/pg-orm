import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, UniqueError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const marks = defineTable('bw_marks', t => ({
  id: t.serial().primaryKey(),
  code: t.text().unique(),
  n: t.int4(),
}))

const ROWS = 100_000
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-bulk-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables: [marks] })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'bulk.db')}`, tables: [marks] })],
]

function rows(count: number, n = 0) {
  return Array.from({ length: count }, (_, i) => ({ code: `c${i}`, n }))
}

describe.each(dialects)('multi-row writes past the parameter limit on %s', (_name, open) => {
  let db: Database

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    await db.raw('DELETE FROM "bw_marks"')
  })

  afterAll(async () => {
    await db.close()
  })

  it('insertMany writes every row and returns the keys in input order', async () => {
    const written = await db.repo(marks).write.insertMany(rows(ROWS))

    expect(written).toHaveLength(ROWS)
    expect(written.every((row, i) => row.code === `c${i}`)).toBe(true)
    expect(await db.repo(marks).read.count()).toBe(ROWS)
  }, 60_000)

  it('upsertMany inserts then updates every row', async () => {
    await db.repo(marks).write.upsertMany(rows(ROWS), ['code'], ['n'], { pk: true })
    const keys = await db.repo(marks).write.upsertMany(rows(ROWS, 1), ['code'], ['n'], { pk: true })

    expect(keys).toHaveLength(ROWS)
    expect(await db.repo(marks).read.count({ n: 1 })).toBe(ROWS)
  }, 60_000)

  it('writes nothing when a later chunk fails', async () => {
    const batch = [...rows(ROWS - 1), { code: 'c0', n: 0 }]

    await expect(db.repo(marks).write.insertMany(batch, { pk: true })).rejects.toThrow(UniqueError)
    expect(await db.repo(marks).read.count()).toBe(0)
  }, 60_000)

  it('stays all-or-nothing inside a transaction, as a savepoint', async () => {
    await db.transaction(async (tx) => {
      await db.repo(marks).using(tx).write.insertOne({ code: 'kept', n: 0 }, { pk: true })
      await expect(db.repo(marks).using(tx).write.insertMany([...rows(ROWS - 1), { code: 'c0', n: 0 }], { pk: true })).rejects.toThrow(UniqueError)
    })

    expect((await db.repo(marks).read.findMany()).map(r => r.code)).toEqual(['kept'])
  }, 60_000)
})
