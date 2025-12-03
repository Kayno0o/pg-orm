import { describe, expect, test } from 'bun:test'
import { orm } from '../src'
import { setupGlobalTestHooks } from './setup'

setupGlobalTestHooks()

describe('Edge Cases - Performance', () => {
  test('should handle large batch inserts efficiently', async () => {
    const User = orm.entity('perf_batch_insert', {
      name: orm.string(),
      email: orm.string(),
      age: orm.number(),
    }).build()

    const users = orm.repo(User)

    await orm.getDB()`DROP TABLE IF EXISTS perf_batch_insert`
    await orm.getDB()`
      CREATE TABLE perf_batch_insert (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        age DOUBLE PRECISION NOT NULL
      )
    `

    const batchSize = 1000
    const data = Array.from({ length: batchSize }, (_, i) => ({
      name: `User${i}`,
      email: `user${i}@example.com`,
      age: 20 + (i % 50),
    }))

    const start = performance.now()

    await users.createMany(data)
    const duration = performance.now() - start

    const count = await users.count()

    expect(count).toBe(batchSize)
    expect(duration).toBeLessThan(5000)

    await orm.getDB()`DROP TABLE IF EXISTS perf_batch_insert`
  })

  test('should handle offset/limit queries efficiently on large datasets', async () => {
    const User = orm.entity('perf_pagination', {
      name: orm.string(),
      score: orm.number(),
    }).build()

    const users = orm.repo(User)

    await orm.getDB()`DROP TABLE IF EXISTS perf_pagination`
    await orm.getDB()`
      CREATE TABLE perf_pagination (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        score DOUBLE PRECISION NOT NULL
      )
    `

    const data = Array.from({ length: 500 }, (_, i) => ({
      name: `User${i}`,
      score: Math.random() * 100,
    }))

    await users.createMany(data)

    const start = performance.now()
    const page1 = await users.query().limit(50).offset(0).execute()
    const page5 = await users.query().limit(50).offset(200).execute()
    const duration = performance.now() - start

    expect(page1).toHaveLength(50)
    expect(page5).toHaveLength(50)
    expect(duration).toBeLessThan(1000)

    await orm.getDB()`DROP TABLE IF EXISTS perf_pagination`
  })

  test('should handle complex queries efficiently', async () => {
    const User = orm.entity('perf_complex_query', {
      name: orm.string(),
      age: orm.number(),
      status: orm.enum(['active', 'inactive', 'pending']),
      metadata: orm.jsonb<any>(),
    }).build()

    const users = orm.repo(User)

    await orm.getDB()`DROP TABLE IF EXISTS perf_complex_query`
    await orm.getDB()`
      CREATE TABLE perf_complex_query (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        age DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL,
        metadata JSONB NOT NULL
      )
    `

    const statuses = ['active', 'inactive', 'pending'] as const
    const data = Array.from({ length: 200 }, (_, i) => ({
      name: `User${i}`,
      age: 20 + (i % 60),
      status: statuses[i % 3]!,
      metadata: { level: i % 10, verified: i % 2 === 0 },
    }))

    await users.createMany(data)

    const start = performance.now()
    const results = await users.query()
      .where('age', '>=', 30)
      .where('age', '<=', 50)
      .whereIn('status', ['active', 'pending'])
      .orderBy('age', 'ASC')
      .limit(20)
      .execute()
    const duration = performance.now() - start

    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(20)
    expect(duration).toBeLessThan(500)

    await orm.getDB()`DROP TABLE IF EXISTS perf_complex_query`
  })

  test('should handle rapid sequential updates', async () => {
    const Counter = orm.entity('perf_updates', {
      name: orm.string(),
      count: orm.number(),
    }).build()

    const counters = orm.repo(Counter)

    await orm.getDB()`DROP TABLE IF EXISTS perf_updates`
    await orm.getDB()`
      CREATE TABLE perf_updates (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        count DOUBLE PRECISION NOT NULL
      )
    `

    const counter = await counters.create({ name: 'Test', count: 0 })

    const start = performance.now()

    for (let i = 1; i <= 50; i++) {
      await counters.update(counter.id, { count: i })
    }
    const duration = performance.now() - start

    const updated = await counters.find(counter.id)

    expect(updated?.count).toBe(50)
    expect(duration).toBeLessThan(2000)

    await orm.getDB()`DROP TABLE IF EXISTS perf_updates`
  })

  test('should handle bulk deletes efficiently', async () => {
    const User = orm.entity('perf_deletes', {
      name: orm.string(),
      active: orm.boolean(),
    }).build()

    const users = orm.repo(User)

    await orm.getDB()`DROP TABLE IF EXISTS perf_deletes`
    await orm.getDB()`
      CREATE TABLE perf_deletes (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        active BOOLEAN NOT NULL
      )
    `

    const data = Array.from({ length: 300 }, (_, i) => ({
      name: `User${i}`,
      active: i % 2 === 0,
    }))
    const created = await users.createMany(data)

    const idsToDelete = created.slice(0, 100).map(u => u.id)

    const start = performance.now()

    await users.deleteMany(idsToDelete)
    const duration = performance.now() - start

    const remaining = await users.count()

    expect(remaining).toBe(200)
    expect(duration).toBeLessThan(1000)

    await orm.getDB()`DROP TABLE IF EXISTS perf_deletes`
  })

  test('should handle query builder chain reuse', async () => {
    const User = orm.entity('perf_query_reuse', {
      name: orm.string(),
      age: orm.number(),
      role: orm.enum(['admin', 'user', 'moderator']),
    }).build()

    const users = orm.repo(User)

    await orm.getDB()`DROP TABLE IF EXISTS perf_query_reuse`
    await orm.getDB()`
      CREATE TABLE perf_query_reuse (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        age DOUBLE PRECISION NOT NULL,
        role TEXT NOT NULL
      )
    `

    const roles = ['admin', 'user', 'moderator'] as const
    const data = Array.from({ length: 100 }, (_, i) => ({
      name: `User${i}`,
      age: 20 + (i % 60),
      role: roles[i % 3]!,
    }))

    await users.createMany(data)

    const start = performance.now()

    for (let i = 0; i < 20; i++) {
      await users.query().where('age', '>=', 30).where('role', '=', 'admin').execute()
    }

    const duration = performance.now() - start

    expect(duration).toBeLessThan(1000)

    await orm.getDB()`DROP TABLE IF EXISTS perf_query_reuse`
  })
})
