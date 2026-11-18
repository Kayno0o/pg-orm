import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Database, ValidationError } from '../../src/index'
import { createTestDb, useFileDatabase } from '../helpers/db'
import { tagsTable, usersTable } from '../helpers/fixtures'

await useFileDatabase()

const tables = [tagsTable, usersTable]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-delete-all-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'delete-all.db')}`, tables })],
]

describe.each(dialects)('deleteAll on %s', (_name, open) => {
  let db: Database

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  afterEach(async () => {
    await db.raw('DELETE FROM "users"')
    await db.raw('DELETE FROM "tags"')
  })

  afterAll(async () => {
    await db.close()
  })

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

  it('refuses a write without a WHERE rather than reaching every row', async () => {
    await db.repo(tagsTable).write.insertOne({ name: 'kept' }, { pk: true })
    const write = db.repo(tagsTable).write
    const missing = undefined as never

    await expect(write.deleteMany(missing, { pk: true })).rejects.toBeInstanceOf(ValidationError)
    await expect(write.forceDelete(missing, { pk: true })).rejects.toBeInstanceOf(ValidationError)
    await expect(write.updateMany({ name: 'x' }, missing, { pk: true })).rejects.toBeInstanceOf(ValidationError)
    expect(await db.repo(tagsTable).read.findMany({ name: 'kept' })).toHaveLength(1)
  })
})
