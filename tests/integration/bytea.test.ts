import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database, defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'

const blobs = defineTable('by_blobs', t => ({
  id: t.serial().primaryKey(),
  data: t.bytea().nullable(),
  nums: t.array(t.int4()).nullable(),
}))

const dir = mkdtempSync(join(tmpdir(), 'pg-orm-bytea-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables: [blobs] })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'bytea.db')}`, tables: [blobs] })],
]

describe.each(dialects)('bytea and numeric arrays on %s', (_name, open) => {
  let db: Database

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
    await db.raw('DELETE FROM "by_blobs"')
  })

  afterAll(async () => {
    await db.close()
  })

  it('reads a bytea back as bytes and a numeric array as an Array, a null first row included', async () => {
    const repo = db.repo(blobs)

    await repo.write.insertMany([{ data: null, nums: null }, { data: Buffer.from([1, 2, 255]), nums: [3, 4] }])

    const rows = await repo.read.findMany(q => q.where(e => e.gt('id', 0)).orderBy('id'))

    expect(rows[1]!.data).toBeInstanceOf(Uint8Array)
    expect([...rows[1]!.data!]).toEqual([1, 2, 255])
    expect(Array.isArray(rows[1]!.nums)).toBe(true)
    expect(rows[1]!.nums).toEqual([3, 4])
  })
})
