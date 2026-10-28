import type { Database, QueryEvent } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable, softDelete, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const notes = defineTable('er_notes', t => ({
  id: t.serial().primaryKey(),
  body: t.text(),
})).withTrait(softDelete())

const plain = defineTable('er_plain', t => ({
  id: t.serial().primaryKey(),
  n: t.int4(),
}))

const hooked = defineTable('er_hooked', t => ({
  id: t.serial().primaryKey(),
  n: t.int4(),
}))
const seen: unknown[] = []

hooked.hook('afterInsert', (rows) => {
  seen.push(...rows.map(row => row.id))
})

const DAY = 86_400_000
const events: QueryEvent[] = []
let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [notes, plain, hooked], onQuery: e => void events.push(e) })
  await db.sync({ allowDestructive: true })
})

beforeEach(async () => {
  await db.raw('TRUNCATE "er_notes", "er_plain", "er_hooked" RESTART IDENTITY')
  await db.repo(notes).write.insertMany([{ body: 'live' }, { body: 'old' }, { body: 'recent' }])
  await db.raw(`UPDATE "er_notes" SET "deletedAt" = now() - interval '40 days' WHERE "body" = 'old'`)
  await db.raw(`UPDATE "er_notes" SET "deletedAt" = now() - interval '2 days' WHERE "body" = 'recent'`)
  events.length = 0
})

afterAll(async () => {
  await db.close()
})

async function bodies(): Promise<string[]> {
  return (await db.repo(notes).read.findMany(q => q.withTrashed().orderBy('id'))).map(row => row.body)
}

describe('purgeTrashed', () => {
  it('hard-deletes the trashed rows older than the cutoff, leaving live and newer trashed rows', async () => {
    const purged = await db.repo(notes).write.purgeTrashed(new Date(Date.now() - 30 * DAY))

    expect(purged.map(row => row.body)).toEqual(['old'])
    expect(await bodies()).toEqual(['live', 'recent'])
  })

  it('refuses a table without softDelete and an invalid cutoff', async () => {
    await expect(db.repo(plain).write.purgeTrashed(new Date())).rejects.toBeInstanceOf(ValidationError)
    await expect(db.repo(notes).write.purgeTrashed(new Date('nope'))).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('returning: false', () => {
  it('sends a many-row write without RETURNING and resolves to nothing', async () => {
    expect(await db.repo(notes).write.purgeTrashed(new Date(), { returning: false })).toBeUndefined()
    expect(await db.repo(notes).write.updateMany({ body: 'x' }, { body: 'live' }, { returning: false })).toBeUndefined()
    expect(await db.repo(plain).write.insertMany([{ n: 1 }, { n: 2 }], { returning: false })).toBeUndefined()
    expect(await db.repo(plain).write.deleteMany({ id: 1 }, { returning: false })).toBeUndefined()
    expect(events.some(e => e.sql.includes('RETURNING'))).toBe(false)
    expect(await bodies()).toEqual(['x'])
    expect(await db.repo(plain).read.count()).toBe(1)
  })

  it('still gives an after-write hook its rows', async () => {
    seen.length = 0

    expect(await db.repo(hooked).write.insertMany([{ n: 1 }, { n: 2 }], { returning: false })).toBeUndefined()
    expect(seen).toEqual([1, 2])
  })
})

describe('paginate withTotal: false', () => {
  it('runs no count and says whether another page follows', async () => {
    const first = await db.repo(notes).read.paginate({ page: 1, perPage: 1, withTotal: false, withTrashed: true })
    const last = await db.repo(notes).read.paginate({ page: 3, perPage: 1, withTotal: false, withTrashed: true })

    expect(first).toEqual({ data: [expect.objectContaining({ body: 'live' })], page: 1, perPage: 1, hasNext: true })
    expect(last.hasNext).toBe(false)
    expect(last).not.toHaveProperty('total')
    expect(events.some(e => e.sql.includes('count('))).toBe(false)
  })

  it('gives hasNext with the total too', async () => {
    const page = await db.repo(notes).read.paginate({ page: 1, perPage: 2, withTrashed: true })

    expect([page.total, page.hasNext]).toEqual([3, true])
  })
})
