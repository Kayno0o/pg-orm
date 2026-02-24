import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'

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
  hookedTable.hook('beforeInsert', (row: any) => {
    hookLog.push('beforeInsert')

    return { ...row, name: row.name.toUpperCase() }
  })
  hookedTable.hook('afterInsert', () => {
    hookLog.push('afterInsert')
  })
  hookedTable.hook('beforeUpdate', (row: any) => {
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

  db = new (await import('../../src/index')).Database({
    url: 'postgres://test:test@127.0.0.1:8532/orm_test',
    tables: [hookedTable],
  })
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

    await repo.insertOne({ name: 'alice', email: 'a@test.com' } as any)

    expect(hookLog).toContain('beforeInsert')
    expect(hookLog).toContain('afterInsert')
  })

  it('beforeInsert transforms data', async () => {
    const repo = db.repo(hookedTable)
    const user = await repo.insertOne({ name: 'alice', email: 'a@test.com' } as any)

    expect(user.name).toBe('ALICE')
  })

  it('fires afterSelect on findMany', async () => {
    const repo = db.repo(hookedTable)

    await repo.insertOne({ name: 'alice', email: 'a@test.com' } as any)
    hookLog.length = 0
    await repo.findMany()

    expect(hookLog).toContain('afterSelect')
  })

  it('fires beforeUpdate and afterUpdate', async () => {
    const repo = db.repo(hookedTable)

    await repo.insertOne({ name: 'alice', email: 'a@test.com' } as any)
    hookLog.length = 0
    await repo.updateMany({ name: 'bob' } as any, e => e.eq('email', 'a@test.com'))

    expect(hookLog).toContain('beforeUpdate')
    expect(hookLog).toContain('afterUpdate')
  })

  it('fires beforeDelete and afterDelete', async () => {
    const repo = db.repo(hookedTable)

    await repo.insertOne({ name: 'alice', email: 'a@test.com' } as any)
    hookLog.length = 0
    await repo.deleteMany(e => e.eq('email', 'a@test.com'))

    expect(hookLog).toContain('beforeDelete')
    expect(hookLog).toContain('afterDelete')
  })

  it('insertMany fires beforeInsert for each row', async () => {
    const repo = db.repo(hookedTable)

    await repo.insertMany([
      { name: 'a', email: 'a@test.com' },
      { name: 'b', email: 'b@test.com' },
    ] as any)

    const insertHooks = hookLog.filter(h => h === 'beforeInsert')

    expect(insertHooks).toHaveLength(2)
  })

  it('hooks run on findOne too', async () => {
    const repo = db.repo(hookedTable)

    await repo.insertOne({ name: 'alice', email: 'a@test.com' } as any)
    hookLog.length = 0
    await repo.findOne()

    expect(hookLog).toContain('afterSelect')
  })

  it('hook order is correct for insert', async () => {
    hookLog.length = 0
    const repo = db.repo(hookedTable)

    await repo.insertOne({ name: 'test', email: 'test@test.com' } as any)

    expect(hookLog.indexOf('beforeInsert')).toBeLessThan(hookLog.indexOf('afterInsert'))
  })
})
