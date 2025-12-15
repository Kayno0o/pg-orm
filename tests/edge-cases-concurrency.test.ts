import { describe, expect, test } from 'bun:test'
import { orm, setupGlobalTestHooks } from './setup'

setupGlobalTestHooks()

describe('Edge Cases - Concurrency', () => {
  test('should handle concurrent reads', async () => {
    const User = orm.entity('concurrency_users', f => ({
      name: f.string(),
      email: f.string(),
    })).build()

    const users = orm.repo(User)

    await orm.getDB()`DROP TABLE IF EXISTS concurrency_users`
    await orm.getDB()`
      CREATE TABLE concurrency_users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL
      )
    `

    const user = await users.create({ name: 'Alice', email: 'alice@example.com' })

    const reads = Array.from({ length: 50 }, () => users.find(user.id))
    const results = await Promise.all(reads)

    expect(results).toHaveLength(50)
    for (const result of results) {
      expect(result?.name).toBe('Alice')
      expect(result?.email).toBe('alice@example.com')
    }

    await orm.getDB()`DROP TABLE IF EXISTS concurrency_users`
  })

  test('should handle concurrent writes to different rows', async () => {
    const User = orm.entity('concurrent_writes', f => ({
      name: f.string(),
      counter: f.number(),
    })).build()

    const users = orm.repo(User)

    await orm.getDB()`DROP TABLE IF EXISTS concurrent_writes`
    await orm.getDB()`
      CREATE TABLE concurrent_writes (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        counter DOUBLE PRECISION NOT NULL
      )
    `

    const writes = Array.from({ length: 20 }, (_, i) =>
      users.create({ name: `User${i}`, counter: i }))

    const results = await Promise.all(writes)

    expect(results).toHaveLength(20)
    const allUsers = await users.findAll()

    expect(allUsers).toHaveLength(20)

    await orm.getDB()`DROP TABLE IF EXISTS concurrent_writes`
  })

  test('should handle concurrent transaction commits', async () => {
    const User = orm.entity('transaction_concurrency', f => ({
      name: f.string(),
      balance: f.number(),
    })).build()

    const users = orm.repo(User)

    await orm.getDB()`DROP TABLE IF EXISTS transaction_concurrency`
    await orm.getDB()`
      CREATE TABLE transaction_concurrency (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        balance DOUBLE PRECISION NOT NULL
      )
    `

    const transactions = Array.from({ length: 10 }, (_, i) =>
      users.transaction(async (tx) => {
        const user = await tx.create({ name: `User${i}`, balance: 100 })

        await tx.update(user.id, { balance: 150 })

        return user
      }))

    const results = await Promise.all(transactions)

    expect(results).toHaveLength(10)
    const allUsers = await users.findAll()

    expect(allUsers).toHaveLength(10)
    for (const user of allUsers) {
      expect(user.balance).toBe(150)
    }

    await orm.getDB()`DROP TABLE IF EXISTS transaction_concurrency`
  })

  test('should handle concurrent query builder operations', async () => {
    const User = orm.entity('query_concurrency', f => ({
      name: f.string(),
      age: f.number(),
    })).build()

    const users = orm.repo(User)

    await orm.getDB()`DROP TABLE IF EXISTS query_concurrency`
    await orm.getDB()`
      CREATE TABLE query_concurrency (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        age DOUBLE PRECISION NOT NULL
      )
    `

    await users.createMany([
      { name: 'Alice', age: 25 },
      { name: 'Bob', age: 30 },
      { name: 'Charlie', age: 35 },
      { name: 'Diana', age: 40 },
    ])

    const queries = [
      users.query().where('age', '>=', 25).execute(),
      users.query().where('age', '<=', 35).execute(),
      users.query().where('name', 'LIKE', '%li%').execute(),
      users.query().orderBy('age', 'DESC').execute(),
    ]

    const results = await Promise.all(queries)

    expect(results[0]).toHaveLength(4)
    expect(results[1]).toHaveLength(3)
    expect(results[2]).toHaveLength(2)
    expect(results[3]).toHaveLength(4)

    await orm.getDB()`DROP TABLE IF EXISTS query_concurrency`
  })

  test('should handle concurrent bulk operations', async () => {
    const User = orm.entity('bulk_concurrency', f => ({
      name: f.string(),
      active: f.boolean(),
    })).build()

    const users = orm.repo(User)

    await orm.getDB()`DROP TABLE IF EXISTS bulk_concurrency`
    await orm.getDB()`
      CREATE TABLE bulk_concurrency (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        active BOOLEAN NOT NULL
      )
    `

    const createOps = Array.from({ length: 5 }, (_, i) =>
      users.createMany([
        { name: `Batch${i}-1`, active: true },
        { name: `Batch${i}-2`, active: false },
      ]))

    await Promise.all(createOps)

    const allUsers = await users.findAll()

    expect(allUsers).toHaveLength(10)

    await orm.getDB()`DROP TABLE IF EXISTS bulk_concurrency`
  })
})
