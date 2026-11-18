import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const rows = defineTable('oo_rows', t => ({
  id: t.serial().primaryKey(),
  grp: t.int4(),
}))

// No primary key and no `id` column: an append-only log.
const log = defineTable('oo_log', t => ({
  at: t.int4(),
  msg: t.text(),
}))

const tables = [rows, log]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-offset-order-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'offset-order.db')}`, tables })],
]

const GROUPS = [3, 1, 2, 3, 1, 2, 3, 2, 1, 4]

describe.each(dialects)('offset reads with no order on %s', (_name, open) => {
  let db: Database

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    await db.raw('DELETE FROM "oo_rows"')
    await db.raw('DELETE FROM "oo_log"')
    await db.repo(rows).write.insertMany(GROUPS.map(grp => ({ grp })), { pk: true })
    await db.repo(log).write.insertMany([{ at: 2, msg: 'b' }, { at: 1, msg: 'a' }, { at: 3, msg: 'c' }], { returning: false })
  })

  afterAll(async () => {
    await db.close()
  })

  it('pages a grouped read by its groups', async () => {
    const page = await db.repo(rows).read.paginate({ page: 1, perPage: 3 }, q => q.groupBy('grp').aggregate(e => ({ c: e.countCol() })))

    expect(page.data).toEqual([{ grp: 1, c: 3 }, { grp: 2, c: 3 }, { grp: 3, c: 3 }])
    expect(page.total).toBe(4)
  })

  it('pages a read grouped by an expression, its total counting the groups', async () => {
    const page = await db.repo(rows).read.paginate({ page: 1, perPage: 10 }, q => q.groupByExpr(e => e.coalesce('grp', 0)).aggregate(e => ({ c: e.countCol() })))
    const picked = await db.repo(rows).read.paginate({ page: 1, perPage: 10 }, q => q.pick().computed(e => e.countCol(), 'c').groupByExpr(e => e.coalesce('grp', 0)))

    expect(page.data.map(r => r.c).sort()).toEqual([1, 3, 3, 3])
    expect(page.total).toBe(4)
    expect(picked.total).toBe(4)
  })

  it('pages a DISTINCT read of picked columns', async () => {
    const page = await db.repo(rows).read.paginate({ page: 2, perPage: 2 }, q => q.pick('grp').distinct())

    expect(page.data).toEqual([{ grp: 3 }, { grp: 4 }])
    expect(page.total).toBe(4)
  })

  it('streams a grouped read', async () => {
    const seen: number[] = []

    for await (const row of db.repo(rows).stream.offset(q => q.groupBy('grp').aggregate(e => ({ c: e.countCol() })), { chunkSize: 2, warn: false }))
      seen.push(row.grp)

    expect(seen).toEqual([1, 2, 3, 4])
  })

  it('pages and streams a table with no primary key', async () => {
    const page = await db.repo(log).read.paginate({ page: 1, perPage: 10 })
    const streamed: number[] = []

    for await (const row of db.repo(log).stream.offset(undefined, { chunkSize: 2, warn: false }))
      streamed.push(row.at)

    expect(page.data.map(r => r.at).sort()).toEqual([1, 2, 3])
    expect(streamed.sort()).toEqual([1, 2, 3])
  })

  it('refuses a by-key operation on a table with no primary key, naming it', async () => {
    const repo = db.repo(log)
    const keyless = { name: 'ValidationError', message: expect.stringContaining('no primary key') }

    await expect(repo.write.updateOne({ at: 1 }, { msg: 'x' })).rejects.toMatchObject(keyless)
    await expect(repo.write.deleteOne({ at: 1 })).rejects.toMatchObject(keyless)
    await expect(repo.write.insertOne({ at: 4, msg: 'd' }, { pk: true })).rejects.toMatchObject(keyless)
    await expect(repo.read.paginateCursor({ take: 2 })).rejects.toMatchObject(keyless)
    await expect(repo.read.findById(1)).rejects.toThrow(ValidationError)
  })
})
