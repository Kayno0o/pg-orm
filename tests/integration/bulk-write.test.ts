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

// The same table with after-write hooks counting the rows they see.
const hooked = defineTable('bw_marks', t => ({
  id: t.serial().primaryKey(),
  code: t.text().unique(),
  n: t.int4(),
}))
const fired = { afterInsert: 0, afterUpdate: 0 }

hooked.hook('afterInsert', (written) => {
  fired.afterInsert += written.length
})
hooked.hook('afterUpdate', (written) => {
  fired.afterUpdate += written.length
})

const log = defineTable('bw_log', t => ({
  id: t.serial().primaryKey(),
  rows: t.int4(),
}))

// The same table again, its after-insert hook writing through ctx.repo and then failing when asked to.
const logged = defineTable('bw_marks', t => ({
  id: t.serial().primaryKey(),
  code: t.text().unique(),
  n: t.int4(),
}))
let failHook = false

logged.hook('afterInsert', async (written, ctx) => {
  await ctx.repo(log).write.insertOne({ rows: written.length }, { pk: true })

  if (failHook)
    throw new Error('hook failed')
})

const ROWS = 100_000
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-bulk-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables: [marks, log] })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'bulk.db')}`, tables: [marks, log] })],
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
    await db.raw('DELETE FROM "bw_log"')
    failHook = false
    fired.afterInsert = 0
    fired.afterUpdate = 0
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

  it('insertMany with skipConflicts skips the rows clashing on the target and answers only those inserted', async () => {
    await db.repo(marks).write.insertMany(rows(ROWS / 2), { pk: true })
    const written = await db.repo(hooked).write.insertMany(rows(ROWS, 1), { skipConflicts: ['code'] })

    expect(written).toHaveLength(ROWS / 2)
    expect(written.every((row, i) => row.code === `c${ROWS / 2 + i}` && row.n === 1)).toBe(true)
    expect(fired.afterInsert).toBe(ROWS / 2)
    expect(await db.repo(marks).read.count()).toBe(ROWS)
    expect(await db.repo(marks).read.count({ n: 0 })).toBe(ROWS / 2)
  }, 60_000)

  it('insertOne with skipConflicts answers null for a clashing row', async () => {
    const repo = db.repo(marks).write

    expect(await repo.insertOne({ code: 'one', n: 0 }, { skipConflicts: ['code'], pk: true })).toEqual(expect.any(Number))
    expect(await repo.insertOne({ code: 'one', n: 1 }, { skipConflicts: ['code'], pk: true })).toBeNull()
    expect(await repo.insertOne({ code: 'one', n: 1 }, { skipConflicts: ['code'] })).toBeNull()
    expect(await repo.insertOne({ code: 'two', n: 1 }, { skipConflicts: ['code'] })).toMatchObject({ code: 'two', n: 1 })
    expect(await repo.insertMany([{ code: 'two', n: 2 }, { code: 'three', n: 2 }], { skipConflicts: ['code'], pk: true })).toEqual([expect.any(Number)])
  })

  it('updateManyById updates every row, firing after-update hooks once every chunk landed', async () => {
    const keys = await db.repo(marks).write.insertMany(rows(ROWS), { pk: true })
    const written = await db.repo(hooked).write.updateManyById(keys.map(id => ({ id, n: 1 })), { pk: true })

    expect(written).toHaveLength(ROWS)
    expect(fired.afterUpdate).toBe(ROWS)
    expect(await db.repo(marks).read.count({ n: 1 })).toBe(ROWS)
  }, 60_000)

  it('updateManyById changes nothing and fires no hook when a later chunk fails', async () => {
    const keys = await db.repo(marks).write.insertMany(rows(ROWS), { pk: true })
    const patches = keys.map((id, i) => ({ id, n: 1, code: i === ROWS - 1 ? 'c0' : `c${i}` }))

    await expect(db.repo(hooked).write.updateManyById(patches, { pk: true })).rejects.toThrow(UniqueError)
    expect(fired.afterUpdate).toBe(0)
    expect(await db.repo(marks).read.count({ n: 0 })).toBe(ROWS)
  }, 60_000)

  it('writes nothing when a later chunk fails', async () => {
    const batch = [...rows(ROWS - 1), { code: 'c0', n: 0 }]

    await expect(db.repo(marks).write.insertMany(batch, { pk: true })).rejects.toThrow(UniqueError)
    expect(await db.repo(marks).read.count()).toBe(0)
  }, 60_000)

  it('fires after-write hooks once every chunk landed, and none for rows a later chunk rolled back', async () => {
    await expect(db.repo(hooked).write.insertMany([...rows(ROWS - 1), { code: 'c0', n: 0 }], { pk: true })).rejects.toThrow(UniqueError)
    expect(fired.afterInsert).toBe(0)

    await db.repo(hooked).write.insertMany(rows(ROWS), { pk: true })
    expect(fired.afterInsert).toBe(ROWS)
  }, 60_000)

  it('tells inserted from updated rows on a hooked upsert of thousands', async () => {
    await db.repo(marks).write.insertMany(rows(1500), { pk: true })
    await db.repo(hooked).write.upsertMany(rows(3000, 1), ['code'], ['n'], { pk: true })

    expect(fired).toEqual({ afterInsert: 1500, afterUpdate: 1500 })
  }, 60_000)

  it('runs after-write hooks inside the chunks\' transaction, ctx.repo writing in it', async () => {
    failHook = true
    await expect(db.repo(logged).write.insertMany(rows(ROWS), { pk: true })).rejects.toThrow('hook failed')
    expect(await db.repo(marks).read.count()).toBe(0)
    expect(await db.repo(log).read.count()).toBe(0)

    failHook = false
    await db.repo(logged).write.insertMany(rows(ROWS), { pk: true })
    expect((await db.repo(log).read.findMany()).reduce((sum, entry) => sum + entry.rows, 0)).toBe(ROWS)
  }, 60_000)

  it('stays all-or-nothing inside a transaction, as a savepoint', async () => {
    await db.transaction(async (tx) => {
      await db.repo(marks).using(tx).write.insertOne({ code: 'kept', n: 0 }, { pk: true })
      await expect(db.repo(marks).using(tx).write.insertMany([...rows(ROWS - 1), { code: 'c0', n: 0 }], { pk: true })).rejects.toThrow(UniqueError)
    })

    expect((await db.repo(marks).read.findMany()).map(r => r.code)).toEqual(['kept'])
  }, 60_000)
})
