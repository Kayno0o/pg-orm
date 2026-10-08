import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { defineTable, softDelete } from '../../src/index'
import { createTestDb, truncateAll } from '../helpers/db'
import { allTables, postsTable, usersTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
  await truncateAll(db)
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

describe('Soft Delete', () => {
  it('deleteMany sets deletedAt instead of removing row', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })

    await repo.write.deleteMany(e => e.eq('id', userId), { pk: true })

    // Row should still exist in DB via withTrashed
    const all = await repo.read.findMany(q => q.withTrashed())

    expect(all).toHaveLength(1)
    expect(all[0]!.deletedAt).not.toBeNull()
  })

  it('findMany excludes soft-deleted rows by default', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })
    await repo.write.insertOne({ name: 'Bob', email: 'b@test.com' }, { pk: true })
    await repo.write.deleteMany(e => e.eq('email', 'a@test.com'), { pk: true })

    const users = await repo.read.findMany()

    expect(users).toHaveLength(1)
    expect(users[0]!.name).toBe('Bob')
  })

  it('withTrashed includes soft-deleted rows', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })
    await repo.write.deleteMany(e => e.eq('email', 'a@test.com'), { pk: true })

    const all = await repo.read.findMany(q => q.withTrashed())

    expect(all).toHaveLength(1)
  })

  it('count excludes soft-deleted rows', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })
    await repo.write.insertOne({ name: 'Bob', email: 'b@test.com' }, { pk: true })
    await repo.write.deleteMany(e => e.eq('email', 'a@test.com'), { pk: true })

    const count = await repo.read.count()

    expect(count).toBe(1)
  })

  it('exists excludes soft-deleted rows', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })
    await repo.write.deleteMany(e => e.eq('email', 'a@test.com'), { pk: true })

    const exists = await repo.read.exists(e => e.eq('email', 'a@test.com'))

    expect(exists).toBe(false)
  })

  it('forceDelete removes row permanently', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })
    await repo.write.forceDelete(e => e.eq('email', 'a@test.com'), { pk: true })

    const all = await repo.read.findMany(q => q.withTrashed())

    expect(all).toHaveLength(0)
  })

  it('isDeleted virtual works correctly', async () => {
    const repo = db.repo(usersTable)

    const userId = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })
    const user = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', userId)))

    expect(user.isDeleted).toBe(false)

    await repo.write.deleteMany(e => e.eq('id', userId), { pk: true })
    const deleted = await repo.read.findMany(q => q.withTrashed())

    expect(deleted[0]!.isDeleted).toBe(true)
  })

  it('deleteOne returns the soft-deleted row', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })
    const result = await repo.write.deleteOne(e => e.eq('email', 'a@test.com'))

    expect(result).not.toBeNull()
    expect(result!.deletedAt).not.toBeNull()
  })

  it('isDeleted virtual is applied on mutation return rows', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })

    // updateMany should apply virtuals on returned rows (was missing before fix)
    const updated = await repo.write.updateMany({ name: 'Alice2' }, e => e.eq('id', userId))

    expect(updated[0]!.isDeleted).toBe(false)

    // deleteMany (soft path) should apply virtuals on returned rows
    const deleted = await repo.write.deleteMany(e => e.eq('id', userId))

    expect(deleted[0]!.isDeleted).toBe(true)
  })

  it('deleteMany bumps updatedAt like any other update', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })
    const before = await repo.read.findByIdOrThrow(userId)

    await Bun.sleep(5)
    await repo.write.deleteById(userId, { pk: true })

    const [after] = await repo.read.findMany(q => q.withTrashed().where({ id: userId }))

    expect(after!.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
  })

  it('deleteMany leaves an already trashed row untouched', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })

    await repo.write.deleteById(userId, { pk: true })
    const [first] = await repo.read.findMany(q => q.withTrashed().where({ id: userId }))

    await Bun.sleep(5)
    const again = await repo.write.deleteMany({ id: userId }, { pk: true })
    const [second] = await repo.read.findMany(q => q.withTrashed().where({ id: userId }))

    expect(again).toEqual([])
    expect(second!.deletedAt).toEqual(first!.deletedAt)
  })
})

describe('Updates on soft-deleted rows', () => {
  async function seed() {
    const users = db.repo(usersTable)
    const [live, trashed] = await users.write.insertMany([
      { name: 'Live', email: 'live@test.com' },
      { name: 'Trashed', email: 'trashed@test.com' },
    ], { pk: true })

    await users.write.deleteById(trashed!, { pk: true })

    return { users, live: live!, trashed: trashed! }
  }

  it('skips them unless asked', async () => {
    const { users, live, trashed } = await seed()

    expect(await users.write.updateMany({ name: 'Renamed' }, { email: { endsWith: '@test.com' } }, { pk: true })).toEqual([live])
    expect(await users.write.updateById(trashed, { name: 'Renamed' }, { pk: true })).toBeNull()
    expect(await users.write.updateById(trashed, { name: 'Restored name' }, { withTrashed: true, pk: true })).toBe(trashed)
    expect((await users.read.findById(trashed, q => q.withTrashed()))?.name).toBe('Restored name')
  })

  it('skips them in a bulk update by id', async () => {
    const { users, live, trashed } = await seed()

    expect(await users.write.updateManyById([{ id: live, name: 'a' }, { id: trashed, name: 'b' }], { pk: true })).toEqual([live])
    expect(await users.write.updateManyById([{ id: trashed, name: 'b' }], { withTrashed: true, pk: true })).toEqual([trashed])
  })
})

describe('include() on a soft-delete target', () => {
  const petsDef = defineTable('sd_pets', t => ({
    id: t.serial().primaryKey(),
    name: t.text(),
    ownerId: t.int4(),
  })).withTrait(softDelete())
  const toys = defineTable('sd_toys', t => ({
    id: t.serial().primaryKey(),
    name: t.text(),
  })).withTrait(softDelete())
  const ownerToys = defineTable('sd_owner_toys', t => ({
    ownerId: t.int4(),
    toyId: t.int4(),
  }))
  const owners = defineTable('sd_owners', t => ({
    id: t.serial().primaryKey(),
    name: t.text(),
  })).withRelations(r => ({
    pets: r.hasMany(() => petsDef, 'ownerId'),
    toys: r.hasManyThrough(() => toys, () => ownerToys, { from: 'ownerId', to: 'toyId' }),
  }))
  const pets = petsDef.withRelations(r => ({
    owner: r.belongsTo(() => owners, 'ownerId'),
  }))
  const extra = [owners, pets, toys, ownerToys]
  let sdb: Database

  beforeAll(async () => {
    sdb = createTestDb({ tables: [...allTables, ...extra] })
    await sdb.sync({ allowDestructive: true })

    const ownerId = await sdb.repo(owners).write.insertOne({ name: 'Ann' }, { pk: true })
    const [, trashedPet] = await sdb.repo(pets).write.insertMany([{ name: 'Live pet', ownerId }, { name: 'Trashed pet', ownerId }], { pk: true })
    const [liveToy, trashedToy] = await sdb.repo(toys).write.insertMany([{ name: 'Live toy' }, { name: 'Trashed toy' }], { pk: true })

    await sdb.raw('INSERT INTO "sd_owner_toys" ("ownerId", "toyId") VALUES ($1, $2), ($1, $3)', [ownerId, liveToy, trashedToy])
    await sdb.repo(pets).write.deleteById(trashedPet!, { pk: true })
    await sdb.repo(toys).write.deleteById(trashedToy!, { pk: true })
  })

  afterAll(async () => {
    for (const table of extra)
      await sdb.raw(`DROP TABLE IF EXISTS "${table.name}"`, [])

    await sdb.close({ timeout: 5000 })
  })

  it('skips trashed rows of a hasMany, with or without a callback, unless withTrashed()', async () => {
    const repo = sdb.repo(owners)
    const names = (rows: { pets: { name: string }[] }[]) => rows[0]!.pets.map(p => p.name).sort()

    expect(names(await repo.read.findMany(q => q.include('pets')))).toEqual(['Live pet'])
    expect(names(await repo.read.findMany(q => q.include('pets', pets, p => p.orderBy('id'))))).toEqual(['Live pet'])
    expect(names(await repo.read.findMany(q => q.include('pets', pets, p => p.withTrashed())))).toEqual(['Live pet', 'Trashed pet'])
  })

  it('skips trashed rows of a hasManyThrough unless withTrashed()', async () => {
    const repo = sdb.repo(owners)
    const names = (rows: { toys: { name: string }[] }[]) => rows[0]!.toys.map(t => t.name).sort()

    expect(names(await repo.read.findMany(q => q.include('toys')))).toEqual(['Live toy'])
    expect(names(await repo.read.findMany(q => q.include('toys', toys, t => t.withTrashed())))).toEqual(['Live toy', 'Trashed toy'])
  })

  it('gives null for a trashed belongsTo parent unless withTrashed()', async () => {
    const users = db.repo(usersTable)
    const authorId = await users.write.insertOne({ name: 'Gone', email: 'gone@test.com' }, { pk: true })
    const posts = db.repo(postsTable)

    await posts.write.insertOne({ title: 't', body: 'b', authorId }, { pk: true })
    await users.write.deleteById(authorId, { pk: true })

    expect((await posts.read.findMany(q => q.include('author')))[0]!.author).toBeNull()
    expect((await posts.read.findMany(q => q.include('author', usersTable, a => a.withTrashed())))[0]!.author?.name).toBe('Gone')
  })
})

describe('select() on a soft-delete table', () => {
  it('drops the trashed-row filter on withTrashed()', () => {
    const users = db.repo(usersTable)

    expect(users.read.select().toSQL().sql).toContain('"deletedAt" IS NULL')
    expect(users.read.select().withTrashed().toSQL().sql).not.toContain('deletedAt')
  })
})

describe('Upserts on a soft-deleted row', () => {
  async function trashed(): Promise<number> {
    const users = db.repo(usersTable)
    const id = await users.write.insertOne({ name: 'Old', email: 'back@test.com' }, { pk: true })

    await users.write.deleteById(id, { pk: true })

    return id
  }

  it('upsertOne restores the trashed row it updates', async () => {
    const id = await trashed()
    const row = await db.repo(usersTable).write.upsertOne({ name: 'New', email: 'back@test.com' }, ['email'])

    expect(row).toMatchObject({ id, name: 'New', deletedAt: null, isDeleted: false })
    expect(await db.repo(usersTable).read.count({ email: 'back@test.com' })).toBe(1)
  })

  it('upsertMany restores every trashed row it updates', async () => {
    const id = await trashed()

    expect(await db.repo(usersTable).write.upsertMany([{ name: 'New', email: 'back@test.com' }], ['email'], undefined, { pk: true })).toEqual([id])
    expect((await db.repo(usersTable).read.findById(id))?.name).toBe('New')
  })

  it('findOrCreate restores a trashed row instead of returning it still trashed', async () => {
    const id = await trashed()
    const row = await db.repo(usersTable).write.findOrCreate({ name: 'Ignored', email: 'back@test.com' }, ['email'])

    expect(row).toMatchObject({ id, name: 'Old', deletedAt: null })
    expect(await db.repo(usersTable).read.exists({ id })).toBe(true)
  })
})
