import type { BaseBuilder } from '../../src/builder/base'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, InsertBuilder, SelectBuilder } from '../../src/index'
import { createTestDb } from '../helpers/db'

const items = defineTable('bg_items', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
  grp: t.text(),
  n: t.int4(),
  note: t.text().nullable(),
}))

const stock = defineTable('bg_stock', t => ({
  id: t.serial().primaryKey(),
  itemId: t.int4(),
  qty: t.int4(),
}))

const archive = defineTable('bg_archive', t => ({
  id: t.int4().primaryKey(),
  name: t.text(),
}))

const docs = defineTable('bg_docs', t => ({
  id: t.serial().primaryKey(),
  meta: t.jsonb<{ tags: string[] }>(),
}))

const tables = [items, stock, archive]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-builder-gaps-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables: [...tables, docs] })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'gaps.db')}`, tables })],
]

describe.each(dialects)('builder gaps on %s', (name, open) => {
  let db: Database
  const ids: Record<string, number> = {}

  const run = (builder: BaseBuilder) => {
    const { sql, params } = builder.toSQL(db.dialect)

    return db.raw<Record<string, unknown>>(sql, params)
  }
  const names = (rows: { name: string }[]) => rows.map(r => r.name)

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    for (const table of ['bg_items', 'bg_stock', 'bg_archive']) await db.raw(`DELETE FROM "${table}"`)

    const rows = await db.repo(items).write.insertMany([
      { name: 'Apple', grp: 'a', n: 1, note: 'x' },
      { name: 'apple pie', grp: 'a', n: 7, note: null },
      { name: 'Banana', grp: 'b', n: 3, note: 'y' },
      { name: 'cherry', grp: 'b', n: 9, note: null },
    ])

    for (const row of rows) ids[row.name] = row.id

    await db.repo(stock).write.insertMany([
      { itemId: ids.Apple!, qty: 5 },
      { itemId: ids.Banana!, qty: 0 },
    ])
  })

  afterAll(async () => {
    await db.close()
  })

  it('contains, startsWith and endsWith match case, their i-variants do not', async () => {
    const read = db.repo(items).read

    expect(names(await read.findMany(q => q.where(e => e.contains('name', 'App')).orderBy('id')))).toEqual(['Apple'])
    expect(names(await read.findMany(q => q.where(e => e.iContains('name', 'App')).orderBy('id')))).toEqual(['Apple', 'apple pie'])
    expect(names(await read.findMany(q => q.where(e => e.startsWith('name', 'a')).orderBy('id')))).toEqual(['apple pie'])
    expect(names(await read.findMany(q => q.where({ name: { iStartsWith: 'a' } }).orderBy('id')))).toEqual(['Apple', 'apple pie'])
    expect(names(await read.findMany(q => q.where(e => e.endsWith('name', 'E')).orderBy('id')))).toEqual([])
    expect(names(await read.findMany(q => q.where(e => e.iEndsWith('name', 'E')).orderBy('id')))).toEqual(['Apple', 'apple pie'])
  })

  it('IS DISTINCT FROM counts a null as a value, NOT LIKE leaves out a match', async () => {
    const repo = db.repo(items).read

    expect(await repo.count(e => e.isDistinctFrom('note', 'x'))).toBe(3)
    expect(await repo.count(e => e.isNotDistinctFrom('note', null))).toBe(2)
    expect(names(await repo.findMany(q => q.where(e => e.notLike('name', '%an%')).orderBy('id')))).toEqual(['Apple', 'apple pie', 'cherry'])
  })

  it('coalesce and CASE in computed columns and in WHERE', async () => {
    const rows = await db.repo(items).read.findMany(q => q
      .pick('name')
      .computed(e => e.coalesce('note', '-'), 'shown')
      .computed(e => e.caseWhen([[e.gt('n', 5), 'big']], 'small'), 'size')
      .orderBy('id'))
    const typed: { name: string, shown: string, size: string }[] = rows

    expect(typed.map(r => `${r.shown}${r.size}`)).toEqual(['xsmall', '-big', 'ysmall', '-big'])
    expect(await db.repo(items).read.count(e => e.eq(e.coalesce('note', '-'), '-'))).toBe(2)
  })

  it('window functions over a declared window and countDistinct read back as numbers', async () => {
    const rows = await db.repo(items).read.findMany(q => q
      .pick('name')
      .window('g', { partitionBy: ['grp'], orderBy: [{ col: 'n', dir: 'desc' }] })
      .computed(e => e.over(e.rowNumber(), 'g'), 'pos')
      .computed(e => e.over(e.sum('n'), 'g'), 'running')
      .orderBy('id'))

    expect(rows.map(r => [r.name, r.pos, r.running])).toEqual([['Apple', 2, 8], ['apple pie', 1, 7], ['Banana', 2, 12], ['cherry', 1, 9]])

    const [counted] = await db.repo(items).read.findMany(q => q.pick().computed(e => e.countDistinct('grp'), 'groups'))

    expect(counted).toEqual({ groups: 2 })
  })

  it('IN and NOT IN a subquery builder, and a CTE from a builder', async () => {
    const stocked = db.repo(stock).read.select().pick('itemId').where(e => e.gt('qty', 0))

    expect(names(await db.repo(items).read.findMany(q => q.where(e => e.inSubquery('id', stocked))))).toEqual(['Apple'])
    expect(names(await db.repo(items).read.findMany(q => q.where(e => e.notInSubquery('id', stocked)).orderBy('id')))).toEqual(['apple pie', 'Banana', 'cherry'])

    const viaCte = await db.repo(items).read.findMany(q => q
      .with('stocked', db.repo(stock).read.select().pick('itemId').where(e => e.gte('qty', 0)))
      .where(e => e.and(e.neq('grp', 'z'), e.inSubquery('id', new SelectBuilder<any>('stocked').pick('itemId'))))
      .orderBy('id'))

    expect(names(viaCte)).toEqual(['Apple', 'Banana'])
  })

  it('orders and groups by an expression', async () => {
    const ordered = await db.repo(items).read.findMany(q => q.orderBy(e => e.caseWhen([[e.eq('grp', 'b'), 0]], 1)).orderBy('n', 'desc'))

    expect(names(ordered)).toEqual(['cherry', 'Banana', 'apple pie', 'Apple'])

    const grouped = await db.repo(items).read.findMany(q => q
      .pick()
      .computed(e => e.countCol(), 'count')
      .computed(e => e.sum('n'), 'total')
      .groupByExpr(e => e.caseWhen([[e.gt('n', 5), 'big']], 'small')))

    expect(grouped.map(r => [r.count, r.total]).sort()).toEqual([[2, 16], [2, 4]])
  })

  it('locks with FOR KEY SHARE, OF a table and NOWAIT', async () => {
    await db.transaction(async (tx) => {
      const shared = await db.repo(items).using(tx).read.findMany(q => q.where({ grp: 'a' }).forKeyShare().noWait())
      const locked = await db.repo(items).using(tx).read.findMany(q => q
        .join(stock, 's', e => e.eq('id', e.ref('s.itemId')))
        .forUpdate()
        .lockOf('bg_items')
        .skipLocked())

      expect(shared).toHaveLength(2)
      expect(names(locked).sort()).toEqual(['Apple', 'Banana'])
    })
  })

  it('INSERT ... SELECT, then skipping every conflicting row with a bare ON CONFLICT DO NOTHING', async () => {
    const source = () => db.repo(items).read.select().pick('id', 'name').where({ grp: 'a' })
    const first = await run(new InsertBuilder<typeof archive.columns>('bg_archive').fromSelect(['id', 'name'], source()).returning('name'))

    expect(first.map(r => r.name).sort()).toEqual(['Apple', 'apple pie'])

    const again = await run(new InsertBuilder<typeof archive.columns>('bg_archive').fromSelect(['id', 'name'], source()).onConflict().doNothing().returning('id'))

    expect(again).toEqual([])
    expect(await db.repo(archive).read.count()).toBe(2)
  })

  it('UPDATE ... FROM sets from the other table and returns only its own columns', async () => {
    const updated = await run(db.repo(items).write.update()
      .from(stock, 's')
      .set(e => ({ n: e.ref('s.qty') }))
      .where(e => e.eq('id', e.ref('s.itemId')))
      .returning())

    expect(updated.map(r => [r.name, r.n]).sort()).toEqual([['Apple', 5], ['Banana', 0]])
    expect(Object.keys(updated[0]!).sort()).toEqual(['grp', 'id', 'n', 'name', 'note'])
  })

  it.skipIf(name === 'sqlite')('DELETE ... USING deletes the rows the other table names', async () => {
    const deleted = await run(db.repo(items).write.delete()
      .using(stock, 's')
      .where(e => e.and(e.eq('id', e.ref('s.itemId')), e.eq('s.qty', 0)))
      .returning('name'))

    expect(deleted).toEqual([{ name: 'Banana' }])
    expect(await db.repo(items).read.count()).toBe(3)
  })

  it.skipIf(name === 'sqlite')('jsonb @> matches a contained document', async () => {
    await db.raw('DELETE FROM "bg_docs"')
    await db.repo(docs).write.insertMany([{ meta: { tags: ['a', 'b'] } }, { meta: { tags: ['c'] } }])

    expect(await db.repo(docs).read.count(e => e.jsonbContains('meta', { tags: ['b'] }))).toBe(1)
  })
})
