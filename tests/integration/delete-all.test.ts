import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { ValidationError } from '../../src/index'
import { createTestDb, truncateAll } from '../helpers/db'
import { tagsTable, usersTable } from '../helpers/fixtures'

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

describe('deleteAll', () => {
  it('deletes every row of a plain table', async () => {
    const ids = await db.repo(tagsTable).write.insertMany([{ name: 'a' }, { name: 'b' }], { pk: true })

    expect([...await db.repo(tagsTable).write.deleteAll({ pk: true })].sort()).toEqual([...ids].sort())
    expect(await db.repo(tagsTable).read.count()).toBe(0)
  })

  it('trashes every live row of a soft-delete table and leaves trashed ones alone', async () => {
    const [a, b] = await db.repo(usersTable).write.insertMany([{ name: 'A', email: 'a@t.com' }, { name: 'B', email: 'b@t.com' }], { pk: true })

    await db.repo(usersTable).write.deleteById(a!, { pk: true })

    expect(await db.repo(usersTable).write.deleteAll({ pk: true })).toEqual([b!])
    expect(await db.repo(usersTable).read.count()).toBe(0)
    expect(await db.repo(usersTable).read.count(undefined, { withTrashed: true })).toBe(2)
  })
})

describe('A write without a WHERE', () => {
  it('is refused rather than reaching every row', async () => {
    await db.repo(tagsTable).write.insertOne({ name: 'kept' }, { pk: true })
    const write = db.repo(tagsTable).write
    const missing = undefined as never

    await expect(write.deleteMany(missing, { pk: true })).rejects.toBeInstanceOf(ValidationError)
    await expect(write.forceDelete(missing, { pk: true })).rejects.toBeInstanceOf(ValidationError)
    await expect(write.updateMany({ name: 'x' }, missing, { pk: true })).rejects.toBeInstanceOf(ValidationError)
    expect(await db.repo(tagsTable).read.findManyBy({ name: 'kept' })).toHaveLength(1)
  })
})
