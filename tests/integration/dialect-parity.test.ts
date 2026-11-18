import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, SelectBuilder, softDelete, ValidationError } from '../../src/index'
import { createTestDb, useFileDatabase } from '../helpers/db'

await useFileDatabase()

const items = defineTable('dp_items', t => ({
  id: t.serial().primaryKey(),
  code: t.text().unique(),
  grp: t.text(),
  n: t.int4(),
}))

const notes = defineTable('dp_notes', t => ({
  id: t.serial().primaryKey(),
  body: t.text(),
})).withTrait(softDelete())

const tables = [items, notes]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-parity-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'parity.db')}`, tables })],
]

describe.each(dialects)('repository operations on %s', (_name, open) => {
  let db: Database

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    await db.raw('DELETE FROM "dp_items"')
    await db.raw('DELETE FROM "dp_notes"')
  })

  afterAll(async () => {
    await db.close()
  })

  async function seedItems(): Promise<void> {
    await db.repo(items).write.insertMany([
      { code: 'a', grp: 'x', n: 1 },
      { code: 'b', grp: 'x', n: 2 },
      { code: 'c', grp: 'y', n: 10 },
    ], { returning: false })
  }

  describe('purgeTrashed', () => {
    it('purgeTrashed hard-deletes only trashed rows older than the cutoff', async () => {
      const [a, b, c] = await db.repo(notes).write.insertMany([{ body: 'a' }, { body: 'b' }, { body: 'c' }], { pk: true })

      await db.repo(notes).write.deleteMany({ id: { in: [a!, b!] } })

      expect(await db.repo(notes).write.purgeTrashed(new Date(Date.now() - 60_000), { pk: true })).toEqual([])
      expect(await db.repo(notes).write.purgeTrashed(new Date(Date.now() + 60_000), { pk: true })).toEqual(expect.arrayContaining([a!, b!]))
      expect(await db.repo(notes).read.count(undefined, { withTrashed: true })).toBe(1)
      expect((await db.repo(notes).read.findByIdOrThrow(c!)).body).toBe('c')
    })

    it('purgeTrashed with returning: false purges and answers nothing', async () => {
      const [a] = await db.repo(notes).write.insertMany([{ body: 'a' }], { pk: true })

      await db.repo(notes).write.deleteById(a!, { pk: true })

      expect(await db.repo(notes).write.purgeTrashed(new Date(Date.now() + 60_000), { returning: false })).toBeUndefined()
      expect(await db.repo(notes).read.count(undefined, { withTrashed: true })).toBe(0)
    })
  })

  describe('skipConflicts and returning: false', () => {
    it('insertMany with skipConflicts returns only the rows it inserted', async () => {
      await seedItems()

      const stored = await db.repo(items).write.insertMany([{ code: 'a', grp: 'z', n: 99 }, { code: 'd', grp: 'z', n: 4 }], { skipConflicts: ['code'] })

      expect(stored.map(row => row.code)).toEqual(['d'])
      expect((await db.repo(items).read.findOneOrThrow({ code: 'a' })).n).toBe(1)
    })

    it('insertOne with skipConflicts answers null for a skipped row', async () => {
      await seedItems()

      expect(await db.repo(items).write.insertOne({ code: 'a', grp: 'z', n: 99 }, { skipConflicts: ['code'] })).toBeNull()
      expect(await db.repo(items).write.insertOne({ code: 'e', grp: 'z', n: 5 }, { skipConflicts: ['code'] })).toMatchObject({ code: 'e' })
    })

    it('many-row writes with returning: false write and send nothing back', async () => {
      const write = db.repo(items).write

      expect(await write.insertMany([{ code: 'a', grp: 'x', n: 1 }, { code: 'b', grp: 'x', n: 2 }], { returning: false })).toBeUndefined()
      expect(await write.updateMany({ n: 7 }, { grp: 'x' }, { returning: false })).toBeUndefined()
      expect((await db.repo(items).read.findMany(q => q.orderBy('code'))).map(row => row.n)).toEqual([7, 7])
      expect(await write.upsertMany([{ code: 'a', grp: 'x', n: 8 }, { code: 'c', grp: 'y', n: 3 }], ['code'], undefined, { returning: false })).toBeUndefined()
      expect(await write.deleteMany({ grp: 'x' }, { returning: false })).toBeUndefined()
      expect((await db.repo(items).read.findMany(q => q.orderBy('code'))).map(row => [row.code, row.n])).toEqual([['c', 3]])
    })

    it('a single-row write refuses returning: false', async () => {
      await expect(db.repo(items).write.insertOne({ code: 'a', grp: 'x', n: 1 }, { returning: false } as never)).rejects.toBeInstanceOf(ValidationError)
      expect(await db.repo(items).read.count()).toBe(0)
    })
  })

  describe('existsById', () => {
    it('tells a live row from a missing one, and a trashed row only when asked', async () => {
      const [id] = await db.repo(notes).write.insertMany([{ body: 'a' }], { pk: true })

      expect(await db.repo(notes).read.existsById(id!)).toBe(true)
      expect(await db.repo(notes).read.existsById(id! + 1000)).toBe(false)

      await db.repo(notes).write.deleteById(id!, { pk: true })

      expect(await db.repo(notes).read.existsById(id!)).toBe(false)
      expect(await db.repo(notes).read.existsById(id!, { withTrashed: true })).toBe(true)
    })
  })

  describe('window functions, CTEs and aggregate()', () => {
    it('numbers rows within a window and sums them as they run', async () => {
      await seedItems()

      const rows = await db.repo(items).read.findMany(q => q
        .pick('code')
        .window('w', { partitionBy: ['grp'], orderBy: [{ col: 'n', dir: 'asc' }] })
        .computed(e => e.over(e.rowNumber(), 'w'), 'rank')
        .computed(e => e.over(e.sum('n'), 'w'), 'running')
        .orderBy('code'))

      expect(rows).toEqual([{ code: 'a', rank: 1, running: 1 }, { code: 'b', rank: 2, running: 3 }, { code: 'c', rank: 1, running: 10 }])
    })

    it('reads lag over an ordered window, null past the edge', async () => {
      await seedItems()

      const rows = await db.repo(items).read.findMany(q => q
        .pick('code')
        .window('w', { orderBy: [{ col: 'n', dir: 'asc' }] })
        .computed(e => e.over(e.lag('n'), 'w'), 'previous')
        .orderBy('code'))

      expect(rows).toEqual([{ code: 'a', previous: null }, { code: 'b', previous: 1 }, { code: 'c', previous: 2 }])
    })

    it('filters through a CTE built from a builder, and from a SQL string', async () => {
      await seedItems()

      const fromBuilder = await db.repo(items).read.findMany(q => q
        .with('big', db.repo(items).read.select().pick('id').where(e => e.gte('n', 2)))
        .where(e => e.inSubquery('id', new SelectBuilder('big').pick('id')))
        .orderBy('code'))
      const fromString = await db.repo(items).read.findMany(q => q
        .with('big', 'SELECT "id" FROM "dp_items" WHERE "n" >= $1', [10])
        .where(e => e.inSubquery('id', new SelectBuilder('big').pick('id'))))

      expect(fromBuilder.map(row => row.code)).toEqual(['b', 'c'])
      expect(fromString.map(row => row.code)).toEqual(['c'])
    })

    it('aggregates the whole table, a group, and a HAVING', async () => {
      await seedItems()

      const [total] = await db.repo(items).read.findMany(q => q.aggregate(e => ({ count: e.countCol(), max: e.max('n'), groups: e.countDistinct('grp') })))
      const grouped = await db.repo(items).read.findMany(q => q.groupBy('grp').aggregate(e => ({ count: e.countCol() })).orderBy('grp'))
      const having = await db.repo(items).read.findMany(q => q.groupBy('grp').aggregate(e => ({ count: e.countCol() })).having(e => e.raw('COUNT(*) > ?', 1)))

      expect(total).toEqual({ count: 3, max: 10, groups: 2 })
      expect(grouped).toEqual([{ grp: 'x', count: 2 }, { grp: 'y', count: 1 }])
      expect(having).toEqual([{ grp: 'x', count: 2 }])
    })
  })
})
