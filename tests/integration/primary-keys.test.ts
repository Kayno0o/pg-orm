import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable, ForeignKeyError, ValidationError } from '../../src/index'
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

describe('By-id calls given something other than a key', () => {
  const notKeys: [string, unknown][] = [['an operator object', { gte: 0 }], ['a neq null map', { neq: null }], ['an IN map', { in: [1, 2] }], ['an array', [1, 2]], ['an isNull map', { isNull: true }], ['null', null], ['undefined', undefined]]

  beforeEach(async () => {
    await db.repo(bigKeyed).write.insertMany([{ v: 'a' }, { v: 'b' }, { v: 'c' }])
    await db.repo(pairs).write.insertMany([{ a: 1, b: 1, v: 'a' }, { a: 1, b: 2, v: 'b' }])
  })

  for (const [name, id] of notKeys) {
    it(`refuse ${name} before any SQL, leaving every row as it was`, async () => {
      const repo = db.repo(bigKeyed)

      await expect(repo.write.updateById(id, { v: 'pwned' })).rejects.toThrow(ValidationError)
      await expect(repo.write.deleteById(id)).rejects.toThrow(ValidationError)
      await expect(repo.read.findById(id)).rejects.toThrow(ValidationError)
      await expect(repo.read.existsById(id)).rejects.toThrow(ValidationError)
      await expect(db.repo(pairs).write.updateById({ a: 1, b: id }, { v: 'pwned' })).rejects.toThrow(ValidationError)
      expect((await repo.read.findMany(q => q.orderBy('id'))).map(r => r.v)).toEqual(['a', 'b', 'c'])
      expect(await db.repo(pairs).read.count({ v: 'pwned' })).toBe(0)
    })
  }

  it('refuse an operator object as a findOrCreate key or an updateManyById key', async () => {
    await expect(db.repo(pairs).write.findOrCreate({ a: { gte: 0 } as unknown as number, b: 1, v: 'x' }, ['a', 'b'])).rejects.toThrow(ValidationError)
    await expect(db.repo(pairs).write.updateManyById([{ a: 1, b: { gte: 0 } as unknown as number, v: 'pwned' }])).rejects.toThrow(ValidationError)
  })

  it('still take a bigint, a numeric string and a composite key', async () => {
    const [first] = await db.repo(bigKeyed).read.findMany(q => q.orderBy('id').limit(1))

    expect(await db.repo(bigKeyed).read.findById(first!.id)).toMatchObject({ v: 'a' })
    expect(await db.repo(bigKeyed).read.findById(String(first!.id))).toMatchObject({ v: 'a' })
    expect(await db.repo(pairs).read.findById({ a: 1, b: 2 })).toMatchObject({ v: 'b' })
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
