import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'

const audit = defineTable('uh_audit', t => ({
  id: t.serial().primaryKey(),
  note: t.text().notNull(),
}))

const tags = defineTable('uh_tags', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull().unique(),
  slug: t.text().notNull(),
  touchedBy: t.text().nullable(),
}))

const seen = { selected: 0, inFlight: 0, maxInFlight: 0 }

tags.hook('beforeInsert', async (row) => {
  seen.inFlight++
  seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight)
  await Bun.sleep(1)
  seen.inFlight--

  return { ...row, slug: row.name.toLowerCase().replaceAll(' ', '-') }
})
tags.hook('beforeUpdate', row => ({ ...row, touchedBy: `update of ${row.name ?? 'a patch'}` }))
tags.hook('afterSelect', (rows) => {
  seen.selected += rows.length
})
tags.hook('afterInsert', async (rows, ctx) => {
  await ctx.repo(audit).write.insertMany(rows.map(row => ({ note: `inserted ${row.name}` })), { pk: true })
})

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [audit, tags] })
  await db.sync({ allowDestructive: true })
})

beforeEach(async () => {
  await db.raw('TRUNCATE "uh_tags", "uh_audit"')
  Object.assign(seen, { selected: 0, inFlight: 0, maxInFlight: 0 })
})

afterAll(async () => {
  await db.close()
})

async function notes(): Promise<string[]> {
  return (await db.repo(audit).read.findMany(q => q.orderBy('id'))).map(row => row.note)
}

describe('upsert and findOrCreate hooks', () => {
  it('run beforeInsert on the rows an upsert or findOrCreate creates', async () => {
    const [upserted] = await db.repo(tags).write.upsertMany([{ name: 'Hello World', slug: '' }], ['name'])
    const { row: created } = await db.repo(tags).write.findOrCreate({ name: 'Bun SQL', slug: '' }, ['name'])

    expect(upserted!.slug).toBe('hello-world')
    expect(created.slug).toBe('bun-sql')
  })

  it('run beforeUpdate on each upsert row, the updated row taking what it set', async () => {
    await db.repo(tags).write.insertMany([{ name: 'a', slug: '' }, { name: 'b', slug: '' }])

    const rows = await db.repo(tags).write.upsertMany([{ name: 'a', slug: '' }, { name: 'b', slug: '' }], ['name'], ['slug'])

    expect(rows.map(row => row.touchedBy)).toEqual(['update of a', 'update of b'])
  })

  it('run afterSelect on the row findOrCreate finds', async () => {
    await db.repo(tags).write.insertOne({ name: 'a', slug: '' })
    seen.selected = 0

    const { created } = await db.repo(tags).write.findOrCreate({ name: 'a', slug: '' }, ['name'])

    expect(created).toBe(false)
    expect(seen.selected).toBe(1)
  })

  it('run many-row hooks one row after another', async () => {
    await db.repo(tags).write.insertMany(['a', 'b', 'c', 'd'].map(name => ({ name, slug: '' })))

    expect(seen.maxInFlight).toBe(1)
  })
})

describe('the hook context', () => {
  it('queries through the database outside a transaction', async () => {
    await db.repo(tags).write.insertOne({ name: 'a', slug: '' })

    expect(await notes()).toEqual(['inserted a'])
  })

  it('queries through the transaction a write runs in, rolling back with it', async () => {
    await expect(db.transaction(async (tx) => {
      await db.repo(tags).using(tx).write.upsertOne({ name: 'a', slug: '' }, ['name'])
      expect(await db.repo(audit).using(tx).read.count()).toBe(1)
      expect(await db.repo(audit).read.count()).toBe(0)

      throw new Error('roll back')
    })).rejects.toThrow('roll back')

    expect(await notes()).toEqual([])
  })
})
