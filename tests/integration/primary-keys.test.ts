import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
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

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [pairs, bigKeyed] })
  await db.sync({ allowDestructive: true })
})

beforeEach(async () => {
  await db.raw('TRUNCATE "pk_pairs", "pk_big"')
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

describe('Composite primary key writes', () => {
  it('return the key as an object holding each part', async () => {
    const one = await db.repo(pairs).write.insertOne({ a: 1, b: 2, v: 'x' })
    const many = await db.repo(pairs).write.insertMany([{ a: 3, b: 4, v: 'y' }])

    expect(one).toEqual({ a: 1, b: 2 })
    expect(many).toEqual([{ a: 3, b: 4 }])
  })

  it('feed the returned key straight back into the by-id ops', async () => {
    const key = await db.repo(pairs).write.insertOne({ a: 1, b: 2, v: 'x' })

    expect(await db.repo(pairs).write.updateById(key, { v: 'y' })).toEqual(key)
    expect(await db.repo(pairs).write.updateManyById([{ ...key, v: 'z' }])).toEqual([key])
    expect((await db.repo(pairs).read.findByIdOrThrow(key)).v).toBe('z')
    expect(await db.repo(pairs).write.deleteById(key)).toEqual(key)
  })

  it('findOrCreate returns the existing key', async () => {
    await db.repo(pairs).write.insertOne({ a: 1, b: 2, v: 'x' })

    expect(await db.repo(pairs).write.findOrCreate({ a: 1, b: 2, v: 'ignored' }, ['a', 'b'])).toEqual({ a: 1, b: 2 })
  })
})

describe('bigserial primary key writes', () => {
  it('return the key as a bigint, as typed', async () => {
    const id = await db.repo(bigKeyed).write.insertOne({ v: 'x' })
    const ids = await db.repo(bigKeyed).write.insertMany([{ v: 'y' }])

    expect(typeof id).toBe('bigint')
    expect(typeof ids[0]).toBe('bigint')
    expect(await db.repo(bigKeyed).write.updateById(id, { v: 'z' })).toBe(id)
  })
})
