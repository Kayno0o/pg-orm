import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, softDelete, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const ordersDef = defineTable('ag_orders', t => ({
  id: t.serial().primaryKey(),
  customerId: t.int4(),
  total: t.int4(),
  amount: t.numeric(10, 2),
  big: t.int8(),
  rate: t.float8(),
  placedAt: t.timestamptz(),
  note: t.text(),
})).withTrait(softDelete())

const profilesDef = defineTable('ag_profiles', t => ({
  id: t.serial().primaryKey(),
  customerId: t.int4(),
}))

const customers = defineTable('ag_customers', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
})).withRelations(r => ({
  orders: r.hasMany(() => ordersDef, 'customerId'),
  profile: r.hasOne(() => profilesDef, 'customerId'),
}))

const tables = [customers, ordersDef, profilesDef]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-aggregates-'))
const EARLY = new Date('2026-01-01T00:00:00.000Z')
const LATE = new Date('2026-03-01T00:00:00.000Z')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'aggregates.db')}`, tables })],
]

async function rejection(work: () => unknown): Promise<unknown> {
  try {
    await work()
  }
  catch (error) {
    return error
  }

  throw new Error('expected a rejection')
}

describe.each(dialects)('relation aggregates on %s', (_name, open) => {
  let db: Database

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  afterAll(async () => {
    await db.close()
  })

  // ann: two live orders and a trashed one, a profile. bob: nothing.
  beforeEach(async () => {
    for (const table of ['ag_orders', 'ag_profiles', 'ag_customers'])
      await db.raw(`DELETE FROM "${table}"`)

    const [ann] = await db.repo(customers).write.insertMany([{ name: 'ann' }, { name: 'bob' }], { pk: true })
    const [, , trashed] = await db.repo(ordersDef).write.insertMany([
      { customerId: ann!, total: 10, amount: '1.10', big: 9007199254740993n, rate: 0.5, placedAt: LATE, note: 'x' },
      { customerId: ann!, total: 20, amount: '2.20', big: 1n, rate: 1.5, placedAt: EARLY, note: 'y' },
      { customerId: ann!, total: 100, amount: '9.00', big: 1n, rate: 9, placedAt: EARLY, note: 'z' },
    ], { pk: true })

    await db.repo(ordersDef).write.deleteById(trashed!)
    await db.repo(profilesDef).write.insertMany([{ customerId: ann! }])
  })

  async function byName<T extends { name: string }>(rows: Promise<T[]>): Promise<Record<string, T>> {
    return Object.fromEntries((await rows).map(row => [row.name, row]))
  }

  it('sums keeping the column\'s precision, null for no related row', async () => {
    const { ann, bob } = await byName(db.repo(customers).read.findMany(q => q.withSum('orders', 'total').withSum('orders', 'big').withSum('orders', 'amount').withSum('orders', 'rate')))
    const total: number | null = ann!.ordersTotalSum
    const big: bigint | null = ann!.ordersBigSum
    const amount: string | null = ann!.ordersAmountSum

    expect(total).toBe(30)
    expect(big).toBe(9007199254740994n)
    expect(typeof amount).toBe('string')
    expect(Number(amount)).toBeCloseTo(3.3)
    expect(ann!.ordersRateSum).toBe(2)
    expect([bob!.ordersTotalSum, bob!.ordersBigSum, bob!.ordersAmountSum, bob!.ordersRateSum]).toEqual([null, null, null, null])
  })

  it('averages, takes the min and max typed as the column', async () => {
    const { ann, bob } = await byName(db.repo(customers).read.findMany(q => q.withAvg('orders', 'total').withAvg('orders', 'big').withMin('orders', 'placedAt').withMax('orders', 'total').withMin('orders', 'note')))
    const earliest: Date | null = ann!.ordersPlacedAtMin

    expect(ann!.ordersTotalAvg).toBe(15)
    expect(Number(ann!.ordersBigAvg)).toBe(4503599627370497)
    expect(earliest).toEqual(EARLY)
    expect(ann!.ordersTotalMax).toBe(20)
    expect(ann!.ordersNoteMin).toBe('x')
    expect([bob!.ordersTotalAvg, bob!.ordersPlacedAtMin, bob!.ordersTotalMax]).toEqual([null, null, null])
  })

  it('flags whether a related row exists, on any relation type', async () => {
    const { ann, bob } = await byName(db.repo(customers).read.findMany(q => q.withExists('orders').withExists('profile', { as: 'hasProfile' })))
    const flag: boolean = ann!.ordersExists

    expect([flag, ann!.hasProfile]).toEqual([true, true])
    expect([bob!.ordersExists, bob!.hasProfile]).toEqual([false, false])
  })

  it('takes withCount\'s alias, filter and withDeleted', async () => {
    const [ann] = await db.repo(customers).read.findMany(q => q
      .where({ name: 'ann' })
      .withSum('orders', 'total', { as: 'big', where: { total: { gt: 15 } } })
      .withSum('orders', 'total', { as: 'all', withDeleted: true })
      .withExists('orders', { as: 'hasHuge', where: e => e.gt('total', 50) })
      .withExists('orders', { as: 'hadHuge', where: e => e.gt('total', 50), withDeleted: true }))

    expect([ann!.big, ann!.all, ann!.hasHuge, ann!.hadHuge]).toEqual([20, 130, false, true])
  })

  it('refuses a column the target lacks, a sum of text and a sum over a hasOne', async () => {
    const repo = db.repo(customers).read

    // @ts-expect-error not a column of ag_orders
    expect(await rejection(() => repo.findMany(q => q.withSum('orders', 'nope')))).toBeInstanceOf(ValidationError)
    expect(await rejection(() => repo.findMany(q => q.withSum('orders', 'note')))).toBeInstanceOf(ValidationError)
    // @ts-expect-error a sum reads a hasMany or hasManyThrough
    expect(await rejection(() => repo.findMany(q => q.withSum('profile', 'id')))).toBeInstanceOf(ValidationError)
  })
})
