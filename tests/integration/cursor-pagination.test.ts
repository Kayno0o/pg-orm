import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, softDelete, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const items = defineTable('cp_items', t => ({
  id: t.serial().primaryKey(),
  grp: t.int4(),
  label: t.text().nullable(),
})).withTrait(softDelete())

const cells = defineTable('cp_cells', t => ({
  x: t.int4().primaryKey(),
  y: t.int4().primaryKey(),
}))

const tables = [items, cells]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-cursor-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'cursor.db')}`, tables })],
]

// Eleven rows whose `grp` ties in runs of up to three.
const GROUPS = [3, 1, 2, 3, 1, 2, 3, 2, 1, 4, 4]

describe.each(dialects)('cursor pagination on %s', (_name, open) => {
  let db: Database
  let ids: number[]

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    await db.raw('DELETE FROM "cp_items"')
    await db.raw('DELETE FROM "cp_cells"')
    ids = await db.repo(items).write.insertMany(GROUPS.map(grp => ({ grp, label: null })), { pk: true })
  })

  afterAll(async () => {
    await db.close()
  })

  async function pages(direction: 'forward' | 'backward', take: number): Promise<number[][]> {
    const out: number[][] = []
    let cursor: number | null = null

    do {
      const page: { data: { id: number }[], nextCursor: number | null } = await db.repo(items).read.paginateCursor({ take, cursor, direction })

      out.push(page.data.map(r => r.id))
      cursor = page.nextCursor
    } while (cursor !== null)

    return out
  }

  it('walks backward pages without overlap', async () => {
    const sorted = [...ids].sort((a, b) => a - b)
    const backward = await pages('backward', 3)

    expect(backward[0]).toEqual(sorted.slice(-3))
    expect(backward.flat().sort((a, b) => a - b)).toEqual(sorted)
    expect(await pages('forward', 3)).toEqual([sorted.slice(0, 3), sorted.slice(3, 6), sorted.slice(6, 9), sorted.slice(9)])
  })

  it('returns every row once on a column with ties, both ways', async () => {
    const expected = ids.map((id, i) => ({ id, grp: GROUPS[i]! })).sort((a, b) => a.grp - b.grp || a.id - b.id)
    const forward: { id: number, grp: number }[] = []
    const backward: { id: number, grp: number }[] = []

    for await (const row of db.repo(items).stream.cursor({ column: 'grp', chunkSize: 2 }))
      forward.push({ id: row.id, grp: row.grp })

    for await (const row of db.repo(items).stream.cursor({ column: 'grp', chunkSize: 2, direction: 'backward' }))
      backward.push({ id: row.id, grp: row.grp })

    expect(forward).toEqual(expected)
    expect(backward).toEqual([...expected].reverse())
  })

  it('hands back a non-key column cursor as its value and the key', async () => {
    const page = await db.repo(items).read.paginateCursor({ take: 2, column: 'grp' })
    const cursor: { value: number, key: number } | null = page.nextCursor

    expect(cursor).toEqual({ value: 1, key: page.data[1]!.id })
  })

  it('refuses a nullable column', async () => {
    await expect(db.repo(items).read.paginateCursor({ take: 2, column: 'label' })).rejects.toThrow(ValidationError)
  })

  it('pages a composite primary key with the key object as cursor', async () => {
    await db.repo(cells).write.insertMany([{ x: 1, y: 2 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 0, y: 5 }], { pk: true })

    const seen: { x: number, y: number }[] = []

    for await (const row of db.repo(cells).stream.cursor({ chunkSize: 1 }))
      seen.push(row)

    const first = await db.repo(cells).read.paginateCursor({ take: 1 })
    const cursor: { x: number, y: number } | null = first.nextCursor

    expect(seen).toEqual([{ x: 0, y: 5 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 1 }])
    expect(cursor).toEqual({ x: 0, y: 5 })
  })

  it('stream.offset() returns every row once, in key order when none is given', async () => {
    const streamed: number[] = []

    for await (const row of db.repo(items).stream.offset(undefined, { chunkSize: 3, unsafe: true }))
      streamed.push(row.id)

    expect(streamed).toEqual([...ids].sort((a, b) => a - b))
  })

  it('takes withTrashed and a callback shaping the rows', async () => {
    await db.repo(items).write.deleteMany({ grp: 4 }, { pk: true })

    const live = await db.repo(items).read.paginateCursor({ take: 20 })
    const all = await db.repo(items).read.paginateCursor({ take: 20, withTrashed: true })
    const picked = await db.repo(items).read.paginateCursor({ take: 20, column: 'grp' }, q => q.pick('id', 'grp').where({ grp: 1 }))

    expect(live.data).toHaveLength(9)
    expect(all.data).toHaveLength(11)
    expect(picked.data.map(r => Object.keys(r).sort())).toEqual([['grp', 'id', 'isDeleted'], ['grp', 'id', 'isDeleted'], ['grp', 'id', 'isDeleted']])
    await expect(db.repo(items).read.paginateCursor({ take: 2, column: 'grp' }, q => q.pick('id'))).rejects.toThrow(ValidationError)
    await expect(db.repo(items).read.paginateCursor({ take: 2 }, q => q.orderBy('grp'))).rejects.toThrow(ValidationError)
  })
})
