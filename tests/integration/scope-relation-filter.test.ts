import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable, OrmError, softDelete } from '../../src/index'
import { createTestDb } from '../helpers/db'

const commentsDef = defineTable('srf_comments', t => ({
  id: t.serial().primaryKey(),
  postId: t.int4(),
}))

const postsDef = defineTable('srf_posts', t => ({
  id: t.serial().primaryKey(),
  slug: t.text().unique(),
  title: t.text(),
}))

const posts = postsDef
  .withRelations(r => ({ comments: r.hasMany(() => commentsDef, 'postId') }))
  .withScope('commented', e => e.has('comments' as never))

let updates = 0

const tags = defineTable('srf_tags', t => ({
  id: t.serial().primaryKey(),
  slug: t.text().unique(),
})).withTrait(softDelete())

tags.hook('beforeUpdate', (row) => {
  updates++

  return row
})

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [posts, commentsDef, tags] })
  await db.sync({ allowDestructive: true })
})

beforeEach(async () => {
  await db.raw('TRUNCATE "srf_comments", "srf_posts", "srf_tags" RESTART IDENTITY')
  await db.repo(posts).write.insertMany([{ slug: 'a', title: 'A' }, { slug: 'b', title: 'B' }], { pk: true })
  await db.repo(commentsDef).write.insertOne({ postId: 1 })
})

afterAll(async () => {
  await db.close()
})

describe('a scope using has()', () => {
  it('works on reads, updates, deletes and the guard of an upsert', async () => {
    const repo = db.repo(posts)

    expect((await repo.read.findMany()).map(row => row.title)).toEqual(['A'])
    expect(await repo.read.count()).toBe(1)
    expect(await repo.write.updateMany({ title: 'A2' }, { id: { in: [1, 2] } }, { pk: true })).toEqual([1])
    expect(await repo.write.upsertMany([{ slug: 'a', title: 'A3' }, { slug: 'b', title: 'B3' }], ['slug'], { pk: true })).toEqual([1])
    expect(await repo.write.deleteMany({ id: { in: [1, 2] } }, { pk: true })).toEqual([1])
  })
})

describe('findOrCreate', () => {
  it('runs no beforeUpdate hook on a live row it only found, but one on a trashed row it restores', async () => {
    const repo = db.repo(tags)

    updates = 0
    await repo.write.insertOne({ slug: 'x' })
    expect((await repo.write.findOrCreate({ slug: 'x' }, ['slug'])).created).toBe(false)
    expect(updates).toBe(0)

    await repo.write.deleteMany({ slug: 'x' })
    updates = 0
    expect((await repo.write.findOrCreate({ slug: 'x' }, ['slug'])).created).toBe(false)
    expect(updates).toBe(1)
  })

  it('says a row hidden by a scope is, rather than reporting it deleted', async () => {
    const run = db.repo(posts).write.findOrCreate({ slug: 'b', title: 'B' }, ['slug'])

    await expect(run).rejects.toBeInstanceOf(OrmError)
    await expect(run).rejects.toThrow(/hidden by a scope/)
  })
})
