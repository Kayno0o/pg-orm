import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable, softDelete, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const listsBase = defineTable('wc_lists', t => ({ id: t.serial().primaryKey(), title: t.text() }))
const items = defineTable('wc_items', t => ({ id: t.serial().primaryKey(), list_id: t.int4(), done: t.boolean().default(false) }))
  .withTrait(softDelete())
const labels = defineTable('wc_labels', t => ({ id: t.serial().primaryKey(), name: t.text() }))
const listLabels = defineTable('wc_list_labels', t => ({ id: t.serial().primaryKey(), list_id: t.int4(), label_id: t.int4() }))
const lists = listsBase.withRelations(r => ({
  items: r.hasMany(() => items, 'list_id'),
  labels: r.hasManyThrough(() => labels, () => listLabels, { from: 'list_id', to: 'label_id' }),
  owner: r.belongsTo(() => labels, 'id'),
}))

let db: Database
let statements = 0

beforeAll(async () => {
  db = createTestDb({ tables: [lists, items, labels, listLabels], onQuery: () => {
    statements++
  } })
  await db.sync({ allowDestructive: true })
})

beforeEach(async () => {
  await db.raw('TRUNCATE "wc_lists", "wc_items", "wc_labels", "wc_list_labels" RESTART IDENTITY')
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

async function seed() {
  const [a, b] = await db.repo(lists).write.insertMany([{ title: 'a' }, { title: 'b' }], { pk: true })
  const [, , trashed] = await db.repo(items).write.insertMany([
    { list_id: a!, done: true },
    { list_id: a! },
    { list_id: a!, done: true },
  ], { pk: true })

  await db.repo(items).write.deleteById(trashed!, { pk: true })

  const [l1, l2] = await db.repo(labels).write.insertMany([{ name: 'x' }, { name: 'y' }], { pk: true })

  await db.repo(listLabels).write.insertMany([{ list_id: a!, label_id: l1! }, { list_id: a!, label_id: l2! }, { list_id: b!, label_id: l1! }], { pk: true })

  return { a: a!, b: b! }
}

describe('withCount', () => {
  it('adds each row\'s number of live children in the same query', async () => {
    const { a, b } = await seed()

    statements = 0
    const rows = await db.repo(lists).read.findMany(q => q.pick('id').withCount('items').withCount('labels').orderBy('id'))

    expect(statements).toBe(1)
    expect(rows).toEqual([{ id: a, itemsCount: 2, labelsCount: 2 }, { id: b, itemsCount: 0, labelsCount: 1 }])
  })

  it('renames the count and filters the children it counts', async () => {
    const { a } = await seed()
    const [row] = await db.repo(lists).read.findMany(q => q.pick('id').withCount('items', { as: 'done_count', where: { done: true } }).where({ id: a }))

    expect(row).toEqual({ id: a, done_count: 1 })
  })

  it('counts soft-deleted children when asked', async () => {
    const { a } = await seed()
    const [row] = await db.repo(lists).read.findMany(q => q.pick('id').withCount('items', { withDeleted: true }).where({ id: a }))

    expect(row).toEqual({ id: a, itemsCount: 3 })
  })

  it('types the count and its filter', async () => {
    await seed()

    const rows = await db.repo(lists).read.findMany(q => q.withCount('items'))
    const count: number = rows[0]!.itemsCount

    // @ts-expect-error the filter is checked against the target's columns
    db.repo(lists).read.select().withCount('items', { where: { nope: 1 } })
    // @ts-expect-error a belongsTo has nothing to count
    db.repo(lists).read.select().withCount('owner')

    expect(typeof count).toBe('number')
  })

  it('rejects a relation it cannot count', async () => {
    await expect(db.repo(lists).read.findMany(q => q.withCount('owner' as never))).rejects.toBeInstanceOf(ValidationError)
  })

  it('works through paginate and stream', async () => {
    const { a } = await seed()
    const page = await db.repo(lists).read.paginate({ page: 1, perPage: 1 }, q => q.pick('id').withCount('items').orderBy('id'))
    const streamed: unknown[] = []

    for await (const row of db.repo(lists).stream.offset(q => q.pick('id').withCount('items').where({ id: a }), { unsafe: true }))
      streamed.push(row)

    expect(page.data).toEqual([{ id: a, itemsCount: 2 }])
    expect(page.total).toBe(2)
    expect(streamed).toEqual([{ id: a, itemsCount: 2 }])
  })
})
