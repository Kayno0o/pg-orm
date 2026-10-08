import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'

// Use a separate table with hooks for isolation
const hookedTable = defineTable('hooked_users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  email: t.text().notNull(),
}))

let db: Database
const hookLog: string[] = []

beforeAll(async () => {
  // Register hooks
  hookedTable.hook('beforeInsert', (row) => {
    hookLog.push('beforeInsert')

    return { ...row, name: row.name.toUpperCase() }
  })
  hookedTable.hook('afterInsert', () => {
    hookLog.push('afterInsert')
  })
  hookedTable.hook('beforeUpdate', (row) => {
    hookLog.push('beforeUpdate')

    return row
  })
  hookedTable.hook('afterUpdate', () => {
    hookLog.push('afterUpdate')
  })
  hookedTable.hook('beforeDelete', () => {
    hookLog.push('beforeDelete')
  })
  hookedTable.hook('afterDelete', () => {
    hookLog.push('afterDelete')
  })
  hookedTable.hook('afterSelect', (rows: any[]) => {
    hookLog.push('afterSelect')

    return rows
  })

  db = createTestDb({ tables: [hookedTable] })
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  hookLog.length = 0
  await db.raw('TRUNCATE "hooked_users" CASCADE', [])
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

describe('Hooks - integration', () => {
  it('fires beforeInsert and afterInsert', async () => {
    const repo = db.repo(hookedTable)

    await repo.write.insertOne({ name: 'alice', email: 'a@test.com' }, { pk: true })

    expect(hookLog).toContain('beforeInsert')
    expect(hookLog).toContain('afterInsert')
  })

  it('beforeInsert transforms data', async () => {
    const repo = db.repo(hookedTable)
    const userId = await repo.write.insertOne({ name: 'alice', email: 'a@test.com' }, { pk: true })
    const user = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', userId)))

    expect(user.name).toBe('ALICE')
  })

  it('fires afterSelect on findMany', async () => {
    const repo = db.repo(hookedTable)

    await repo.write.insertOne({ name: 'alice', email: 'a@test.com' }, { pk: true })
    hookLog.length = 0
    await repo.read.findMany()

    expect(hookLog).toContain('afterSelect')
  })

  it('fires beforeUpdate and afterUpdate', async () => {
    const repo = db.repo(hookedTable)

    await repo.write.insertOne({ name: 'alice', email: 'a@test.com' }, { pk: true })
    hookLog.length = 0
    await repo.write.updateMany({ name: 'bob' }, e => e.eq('email', 'a@test.com'), { pk: true })

    expect(hookLog).toContain('beforeUpdate')
    expect(hookLog).toContain('afterUpdate')
  })

  it('fires beforeDelete and afterDelete', async () => {
    const repo = db.repo(hookedTable)

    await repo.write.insertOne({ name: 'alice', email: 'a@test.com' }, { pk: true })
    hookLog.length = 0
    await repo.write.deleteMany(e => e.eq('email', 'a@test.com'), { pk: true })

    expect(hookLog).toContain('beforeDelete')
    expect(hookLog).toContain('afterDelete')
  })

  it('insertMany fires beforeInsert for each row', async () => {
    const repo = db.repo(hookedTable)

    await repo.write.insertMany([
      { name: 'a', email: 'a@test.com' },
      { name: 'b', email: 'b@test.com' },
    ], { pk: true })

    const insertHooks = hookLog.filter(h => h === 'beforeInsert')

    expect(insertHooks).toHaveLength(2)
  })

  it('hooks run on findOne too', async () => {
    const repo = db.repo(hookedTable)

    await repo.write.insertOne({ name: 'alice', email: 'a@test.com' }, { pk: true })
    hookLog.length = 0
    await repo.read.findOne()

    expect(hookLog).toContain('afterSelect')
  })

  it('hook order is correct for insert', async () => {
    hookLog.length = 0
    const repo = db.repo(hookedTable)

    await repo.write.insertOne({ name: 'test', email: 'test@test.com' }, { pk: true })

    expect(hookLog.indexOf('beforeInsert')).toBeLessThan(hookLog.indexOf('afterInsert'))
  })
})

describe('Hooks - upsert and findOrCreate outcome', () => {
  it('upsertMany fires afterInsert for inserted rows and afterUpdate for updated ones', async () => {
    const repo = db.repo(hookedTable)

    await repo.write.insertOne({ id: 1, name: 'a', email: 'a@test.com' }, { pk: true })
    hookLog.length = 0
    await repo.write.upsertMany([{ id: 1, name: 'a2', email: 'a@test.com' }, { id: 2, name: 'b', email: 'b@test.com' }], ['id'], undefined, { pk: true })

    expect(hookLog.filter(h => h === 'afterInsert')).toHaveLength(1)
    expect(hookLog.filter(h => h === 'afterUpdate')).toHaveLength(1)
  })

  it('findOrCreate reports created and fires afterInsert only when it inserted', async () => {
    const repo = db.repo(hookedTable)

    const first = await repo.write.findOrCreate({ id: 1, name: 'a', email: 'a@test.com' }, ['id'])

    expect(first.created).toBe(true)
    expect(hookLog).toContain('afterInsert')

    hookLog.length = 0
    const second = await repo.write.findOrCreate({ id: 1, name: 'z', email: 'z@test.com' }, ['id'])

    expect(second).toEqual({ row: first.row, created: false })
    expect(hookLog).not.toContain('afterInsert')
  })
})

describe('Hooks - writes touching no row', () => {
  it('fire no after-write hook', async () => {
    const repo = db.repo(hookedTable)

    await repo.write.updateMany({ name: 'x' }, { email: 'missing@test.com' }, { pk: true })
    await repo.write.deleteMany({ email: 'missing@test.com' }, { pk: true })

    expect(hookLog).not.toContain('afterUpdate')
    expect(hookLog).not.toContain('afterDelete')
  })
})
