import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable, ForeignKeyError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const pairs = defineTable('pk_pairs', t => ({
  a: t.int4().primaryKey(),
  b: t.int4().primaryKey(),
  v: t.text(),
}))

const bigKeyed = defineTable('pk_big', t => ({
  id: t.bigserial().primaryKey(),
  v: t.text(),
}))

const folders = defineTable('pk_folders', t => ({
  id: t.serial().primaryKey(),
  parentId: t.int4().nullable().references('pk_folders', 'id', { onDelete: 'cascade' }),
}))

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [pairs, bigKeyed, folders] })
  await db.sync({ allowDestructive: true })
})

beforeEach(async () => {
  await db.raw('TRUNCATE "pk_pairs", "pk_big", "pk_folders"')
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

describe('Composite primary key writes', () => {
  it('return the key as an object holding each part', async () => {
    const one = await db.repo(pairs).write.insertOne({ a: 1, b: 2, v: 'x' }, { pk: true })
    const many = await db.repo(pairs).write.insertMany([{ a: 3, b: 4, v: 'y' }], { pk: true })

    expect(one).toEqual({ a: 1, b: 2 })
    expect(many).toEqual([{ a: 3, b: 4 }])
  })

  it('feed the returned key straight back into the by-id ops', async () => {
    const key = await db.repo(pairs).write.insertOne({ a: 1, b: 2, v: 'x' }, { pk: true })

    expect(await db.repo(pairs).write.updateById(key, { v: 'y' }, { pk: true })).toEqual(key)
    expect(await db.repo(pairs).write.updateManyById([{ ...key, v: 'z' }], { pk: true })).toEqual([key])
    expect((await db.repo(pairs).read.findByIdOrThrow(key)).v).toBe('z')
    expect(await db.repo(pairs).write.deleteById(key, { pk: true })).toEqual(key)
  })

  it('findOrCreate returns the existing key', async () => {
    await db.repo(pairs).write.insertOne({ a: 1, b: 2, v: 'x' }, { pk: true })

    expect((await db.repo(pairs).write.findOrCreate({ a: 1, b: 2, v: 'ignored' }, ['a', 'b'])).row).toMatchObject({ a: 1, b: 2 })
  })
})

describe('bigserial primary key writes', () => {
  it('return the key as a bigint, as typed', async () => {
    const id = await db.repo(bigKeyed).write.insertOne({ v: 'x' }, { pk: true })
    const ids = await db.repo(bigKeyed).write.insertMany([{ v: 'y' }], { pk: true })

    expect(typeof id).toBe('bigint')
    expect(typeof ids[0]).toBe('bigint')
    expect(await db.repo(bigKeyed).write.updateById(id, { v: 'z' }, { pk: true })).toBe(id)
  })
})

describe('Self-referencing foreign key by table name', () => {
  it('is enforced and cascades', async () => {
    const root = await db.repo(folders).write.insertOne({ parentId: null })

    await db.repo(folders).write.insertOne({ parentId: root.id })
    await expect(db.repo(folders).write.insertOne({ parentId: 999 })).rejects.toThrow(ForeignKeyError)

    await db.repo(folders).write.deleteById(root.id)
    expect(await db.repo(folders).read.count()).toBe(0)
  })
})
