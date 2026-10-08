import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createTestDb, truncateAll } from '../helpers/db'
import { bigItemsTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

const BIG_MAX = 9_223_372_036_854_775_807n
const BIG_MIN = -9_223_372_036_854_775_808n

describe('bigint — round-trip', () => {
  it('preserves bigint type (not coerced to number or string)', async () => {
    const repo = db.repo(bigItemsTable)
    const id = await repo.write.insertOne({ big: 1n }, { pk: true })
    const row = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(typeof row.big).toBe('bigint')
    expect(row.big).toBe(1n)
  })

  it('round-trips 0n', async () => {
    const repo = db.repo(bigItemsTable)
    const id = await repo.write.insertOne({ big: 0n }, { pk: true })
    const row = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(row.big).toBe(0n)
  })

  it('round-trips MAX bigint (9223372036854775807)', async () => {
    const repo = db.repo(bigItemsTable)
    const id = await repo.write.insertOne({ big: BIG_MAX }, { pk: true })
    const row = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(row.big).toBe(BIG_MAX)
  })

  it('round-trips MIN bigint (-9223372036854775808)', async () => {
    const repo = db.repo(bigItemsTable)
    const id = await repo.write.insertOne({ big: BIG_MIN }, { pk: true })
    const row = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(row.big).toBe(BIG_MIN)
  })

  it('round-trips a value beyond Number.MAX_SAFE_INTEGER without precision loss', async () => {
    const v = BigInt(Number.MAX_SAFE_INTEGER) + 10n
    const repo = db.repo(bigItemsTable)
    const id = await repo.write.insertOne({ big: v }, { pk: true })
    const row = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(row.big).toBe(v)
    expect(row.big).not.toBe(Number(v) as unknown as bigint)
  })

  it('handles nullable bigint as null', async () => {
    const repo = db.repo(bigItemsTable)
    const id = await repo.write.insertOne({ big: 1n, bigNullable: null }, { pk: true })
    const row = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(row.bigNullable).toBeNull()
  })

  it('updates a bigint column preserving precision', async () => {
    const repo = db.repo(bigItemsTable)
    const id = await repo.write.insertOne({ big: 1n }, { pk: true })

    await repo.write.updateMany({ big: BIG_MAX }, e => e.eq('id', id), { pk: true })

    const row = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', id)))

    expect(row.big).toBe(BIG_MAX)
  })

  it('filters by exact bigint match', async () => {
    const repo = db.repo(bigItemsTable)

    await repo.write.insertOne({ big: BIG_MAX }, { pk: true })
    await repo.write.insertOne({ big: 1n }, { pk: true })

    const matches = await repo.read.findMany(q => q.where(e => e.eq('big', BIG_MAX)))

    expect(matches).toHaveLength(1)
    expect(matches[0]!.big).toBe(BIG_MAX)
  })

  it('insertMany round-trips a mix of bigints', async () => {
    const repo = db.repo(bigItemsTable)
    const values = [0n, 1n, BIG_MAX, BIG_MIN, BigInt(Number.MAX_SAFE_INTEGER) + 1n]

    await repo.write.insertMany(values.map(big => ({ big })), { pk: true })

    const rows = await repo.read.findMany(q => q.orderBy('id', 'asc'))

    expect(rows.map(r => r.big)).toEqual(values)
  })
})
