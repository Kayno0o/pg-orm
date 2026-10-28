import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, softDelete, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const itemsDef = defineTable('wh_items', t => ({
  id: t.serial().primaryKey(),
  orderId: t.int4(),
  sku: t.text(),
}))

const tagsDef = defineTable('wh_tags', t => ({
  id: t.serial().primaryKey(),
  label: t.text(),
}))

const taggingsDef = defineTable('wh_taggings', t => ({
  id: t.serial().primaryKey(),
  customerId: t.int4(),
  tagId: t.int4(),
})).withTrait(softDelete())

const profilesDef = defineTable('wh_profiles', t => ({
  id: t.serial().primaryKey(),
  customerId: t.int4(),
  bio: t.text(),
}))

const customersDef = defineTable('wh_customers', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
  referrerId: t.int4().nullable(),
}))

const ordersDef = defineTable('wh_orders', t => ({
  id: t.serial().primaryKey(),
  customerId: t.int4(),
  status: t.text(),
})).withTrait(softDelete())

const orders = ordersDef.withRelations(r => ({
  customer: r.belongsTo(() => customersDef, 'customerId'),
  items: r.hasMany(() => itemsDef, 'orderId'),
}))

const customers = customersDef.withRelations(r => ({
  orders: r.hasMany(() => orders, 'customerId'),
  profile: r.hasOne(() => profilesDef, 'customerId'),
  tags: r.hasManyThrough(() => tagsDef, () => taggingsDef, { from: 'customerId', to: 'tagId' }),
  referrer: r.belongsTo(() => customersDef, 'referrerId'),
  referrals: r.hasMany(() => customersDef, 'referrerId'),
}))

const pairs = defineTable('wh_pairs', t => ({
  a: t.int4().primaryKey(),
  b: t.int4().primaryKey(),
})).withRelations(r => ({
  orders: r.hasMany(() => ordersDef, 'customerId'),
}))

const tables = [customers, orders, itemsDef, tagsDef, taggingsDef, profilesDef, pairs]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-where-has-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, (subset?: typeof tables) => Database][] = [
  ['postgres', subset => createTestDb({ tables: subset ?? tables })],
  ['sqlite', subset => new Database({ url: `sqlite://${join(dir, subset ? 'partial.db' : 'where-has.db')}`, tables: subset ?? tables })],
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

async function names(rows: Promise<{ name: string }[]>): Promise<string[]> {
  return (await rows).map(row => row.name).sort()
}

describe.each(dialects)('a relation filter on %s', (_name, open) => {
  let db: Database

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  afterAll(async () => {
    await db.close()
  })

  // ann: a paid order with item "a", a profile, the tag "vip". bob, referred by ann: a trashed paid order, a pending one, the tag "new" through a trashed pivot row. cid: nothing.
  beforeEach(async () => {
    for (const table of ['wh_items', 'wh_taggings', 'wh_tags', 'wh_profiles', 'wh_orders', 'wh_customers'])
      await db.raw(`DELETE FROM "${table}"`)

    const [ann] = await db.repo(customers).write.insertMany([{ name: 'ann' }], { pk: true })
    const [bob, cid] = await db.repo(customers).write.insertMany([{ name: 'bob', referrerId: ann! }, { name: 'cid' }], { pk: true })
    const [paid, trashed] = await db.repo(orders).write.insertMany([
      { customerId: ann!, status: 'paid' },
      { customerId: bob!, status: 'paid' },
      { customerId: bob!, status: 'pending' },
    ], { pk: true })
    const [vip, fresh] = await db.repo(tagsDef).write.insertMany([{ label: 'vip' }, { label: 'new' }], { pk: true })
    const [, left] = await db.repo(taggingsDef).write.insertMany([{ customerId: ann!, tagId: vip! }, { customerId: bob!, tagId: fresh! }], { pk: true })

    await db.repo(itemsDef).write.insertMany([{ orderId: paid!, sku: 'a' }])
    await db.repo(profilesDef).write.insertMany([{ customerId: ann!, bio: 'hi' }])
    await db.repo(orders).write.deleteById(trashed!)
    await db.repo(taggingsDef).write.deleteById(left!)
    expect(cid).toBeDefined()
  })

  it('keeps rows with a related row matching the callback, a trashed one only when asked', async () => {
    const repo = db.repo(customers).read

    expect(await names(repo.findMany(q => q.whereHas('orders', o => o.eq('status', 'paid'))))).toEqual(['ann'])
    expect(await names(repo.findMany(q => q.whereHas('orders', o => o.eq('status', 'paid'), { withTrashed: true })))).toEqual(['ann', 'bob'])
    expect(await names(repo.findMany(q => q.whereDoesntHave('orders')))).toEqual(['cid'])
  })

  it('follows belongsTo, hasOne and hasManyThrough, a trashed pivot row linking nothing', async () => {
    const live = await db.repo(orders).read.findMany(q => q.whereHas('customer', c => c.eq('name', 'bob')))

    expect(live.map(order => order.status)).toEqual(['pending'])
    expect(await names(db.repo(customers).read.findMany(q => q.whereHas('profile')))).toEqual(['ann'])
    expect(await names(db.repo(customers).read.findMany(q => q.whereHas('tags')))).toEqual(['ann'])
    expect(await names(db.repo(customers).read.findMany(q => q.whereHas('tags', t => t.eq('label', 'new'), { withoutScopes: ['softDelete'] })))).toEqual(['bob'])
  })

  it('correlates a self-relation with the outer row', async () => {
    const repo = db.repo(customers).read

    expect(await names(repo.findMany(q => q.whereHas('referrer', r => r.eq('name', 'ann'))))).toEqual(['bob'])
    expect(await names(repo.findMany(q => q.whereHas('referrals')))).toEqual(['ann'])
  })

  it('nests, and composes inside e.and, e.or and e.not', async () => {
    const repo = db.repo(customers).read

    expect(await names(repo.findMany(q => q.whereHas('orders', o => o.has('items', i => i.eq('sku', 'a')))))).toEqual(['ann'])
    expect(await names(repo.findMany(q => q.where(e => e.or(e.eq('name', 'cid'), e.has('profile')))))).toEqual(['ann', 'cid'])
    expect(await names(repo.findMany(q => q.where(e => e.and(e.not(e.has('profile')), e.has('orders')))))).toEqual(['bob'])
  })

  it('filters count, exists, paginate, a stream and an include', async () => {
    const repo = db.repo(customers).read
    const streamed: string[] = []

    for await (const row of db.repo(customers).stream.cursor({}, q => q.whereHas('orders')))
      streamed.push(row.name)

    const [ann] = await db.repo(orders).read.findMany(q => q.whereHas('items').include('customer', customers, c => c.whereHas('tags')))

    expect(await repo.count(e => e.has('orders'))).toBe(2)
    expect(await repo.exists(e => e.has('tags', t => t.eq('label', 'new')))).toBe(false)
    expect((await repo.paginate({ page: 1, perPage: 10 }, q => q.whereDoesntHave('profile'))).total).toBe(2)
    expect(streamed.sort()).toEqual(['ann', 'bob'])
    expect((ann!.customer as { name: string }).name).toBe('ann')
  })

  it('filters updates and deletes', async () => {
    const write = db.repo(customers).write

    expect((await write.updateMany({ name: 'buyer' }, e => e.has('orders', o => o.eq('status', 'paid')))).length).toBe(1)
    expect((await write.deleteMany(e => e.doesntHave('orders'))).map(row => row.name)).toEqual(['cid'])
    expect(await db.repo(orders).write.deleteMany(e => e.has('customer', c => c.eq('name', 'buyer')))).toHaveLength(1)
    expect(await names(db.repo(customers).read.findMany())).toEqual(['bob', 'buyer'])
  })

  it('refuses an unknown relation, a composite key and a table missing from config.tables', async () => {
    const partial = open(tables.filter(table => table !== itemsDef))

    try {
      const missing = await rejection(() => partial.repo(orders).read.findMany(q => q.whereHas('items')))

      expect(missing).toBeInstanceOf(ValidationError)
      expect((missing as Error).message).toContain('"wh_items"')
      expect(await rejection(() => db.repo(pairs).read.count(e => e.has('orders')))).toBeInstanceOf(ValidationError)
      expect(await rejection(() => db.repo(customers).read.count(e => e.has('nope' as 'orders')))).toBeInstanceOf(ValidationError)
    }
    finally {
      await partial.close()
    }
  })

  it('cannot be printed by a builder outside a repository', () => {
    expect(() => db.repo(customers).read.select().where(e => e.has('orders')).toSQL()).toThrow(ValidationError)
  })
})
