import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTxRepo, getTestSchema, orm, runInTransaction, setupTestDatabase, setupTestSuite, teardownTestDatabase, teardownTestSuite, testData } from './setup'

const User = orm.entity('test_expr_users', f => ({
  name: f.string(),
  email: f.string(),
  age: f.number().nullable(),
  role: f.enum(['admin', 'user', 'moderator'] as const),
  tags: f.array('string'),
  metadata: f.jsonb().nullable(),
})).build()

describe('Expression Builder', () => {
  beforeAll(async () => {
    orm.repo(User)
    await setupTestDatabase({ schema: getTestSchema() })
    setupTestSuite('expression')
  })

  afterAll(async () => {
    teardownTestSuite('expression')
    await teardownTestDatabase({ schema: getTestSchema() })
  })

  describe('Simple Conditions', () => {
    test('eq', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice' })
        await users.create({ ...testData.user.valid(), name: 'Bob' })

        const results = await users.query()
          .where(e => e.eq('name', 'Alice'))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.name).toBe('Alice')
      })
    })

    test('neq', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice' })
        await users.create({ ...testData.user.valid(), name: 'Bob' })

        const results = await users.query()
          .where(e => e.neq('name', 'Alice'))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.name).toBe('Bob')
      })
    })

    test('gt', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: 20 })
        await users.create({ ...testData.user.valid(), age: 40 })

        const results = await users.query()
          .where(e => e.gt('age', 25))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.age).toBe(40)
      })
    })

    test('gte', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: 25 })
        await users.create({ ...testData.user.valid(), age: 30 })
        await users.create({ ...testData.user.valid(), age: 20 })

        const results = await users.query()
          .where(e => e.gte('age', 25))
          .execute()

        expect(results.length).toBe(2)
      })
    })

    test('lt', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: 18 })
        await users.create({ ...testData.user.valid(), age: 40 })

        const results = await users.query()
          .where(e => e.lt('age', 25))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.age).toBe(18)
      })
    })

    test('lte', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: 25 })
        await users.create({ ...testData.user.valid(), age: 30 })
        await users.create({ ...testData.user.valid(), age: 20 })

        const results = await users.query()
          .where(e => e.lte('age', 25))
          .execute()

        expect(results.length).toBe(2)
      })
    })
  })

  describe('Pattern Matching', () => {
    test('like', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice Smith' })
        await users.create({ ...testData.user.valid(), name: 'Bob Jones' })

        const results = await users.query()
          .where(e => e.like('name', 'Alice%'))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.name).toBe('Alice Smith')
      })
    })

    test('ilike', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice Smith' })
        await users.create({ ...testData.user.valid(), name: 'Bob Jones' })

        const results = await users.query()
          .where(e => e.ilike('name', 'alice%'))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.name).toBe('Alice Smith')
      })
    })
  })

  describe('Set Operations', () => {
    test('in', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'moderator' })
        await users.create({ ...testData.user.valid(), role: 'user' })

        const results = await users.query()
          .where(e => e.in('role', ['admin', 'moderator']))
          .execute()

        expect(results.length).toBe(2)
        expect(results.every(u => u.role === 'admin' || u.role === 'moderator')).toBe(true)
      })
    })

    test('notIn', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'user' })
        await users.create({ ...testData.user.valid(), role: 'user' })

        const results = await users.query()
          .where(e => e.notIn('role', ['admin']))
          .execute()

        expect(results.length).toBe(2)
        expect(results.every(u => u.role === 'user')).toBe(true)
      })
    })

    test('in with empty array returns no results', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin' })

        const results = await users.query()
          .where(e => e.in('role', []))
          .execute()

        expect(results.length).toBe(0)
      })
    })

    test('notIn with empty array returns all results', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'user' })

        const results = await users.query()
          .where(e => e.notIn('role', []))
          .execute()

        expect(results.length).toBe(2)
      })
    })
  })

  describe('Null Checks', () => {
    test('isNull', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: null })
        await users.create({ ...testData.user.valid(), age: 25 })

        const results = await users.query()
          .where(e => e.isNull('age'))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.age).toBeNull()
      })
    })

    test('isNotNull', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: null })
        await users.create({ ...testData.user.valid(), age: 25 })

        const results = await users.query()
          .where(e => e.isNotNull('age'))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.age).toBe(25)
      })
    })
  })

  describe('Range', () => {
    test('between', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: 18 })
        await users.create({ ...testData.user.valid(), age: 25 })
        await users.create({ ...testData.user.valid(), age: 35 })
        await users.create({ ...testData.user.valid(), age: 50 })

        const results = await users.query()
          .where(e => e.between('age', 20, 40))
          .execute()

        expect(results.length).toBe(2)
        expect(results.every(u => u.age! >= 20 && u.age! <= 40)).toBe(true)
      })
    })
  })

  describe('Composition', () => {
    test('and(...)', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin', age: 30 })
        await users.create({ ...testData.user.valid(), role: 'admin', age: 20 })
        await users.create({ ...testData.user.valid(), role: 'user', age: 30 })

        const results = await users.query()
          .where(e => e.and(
            e.eq('role', 'admin'),
            e.gte('age', 25),
          ))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.role).toBe('admin')
        expect(results[0]?.age).toBe(30)
      })
    })

    test('or(...)', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice' })
        await users.create({ ...testData.user.valid(), name: 'Bob' })
        await users.create({ ...testData.user.valid(), name: 'Charlie' })

        const results = await users.query()
          .where(e => e.or(
            e.eq('name', 'Alice'),
            e.eq('name', 'Bob'),
          ))
          .orderBy('name', 'ASC')
          .execute()

        expect(results.length).toBe(2)
        expect(results[0]?.name).toBe('Alice')
        expect(results[1]?.name).toBe('Bob')
      })
    })

    test('not(...)', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'user' })
        await users.create({ ...testData.user.valid(), role: 'user' })

        const results = await users.query()
          .where(e => e.not(e.eq('role', 'admin')))
          .execute()

        expect(results.length).toBe(2)
        expect(results.every(u => u.role === 'user')).toBe(true)
      })
    })
  })

  describe('Nesting', () => {
    test('or(and(...), and(...))', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        // Should match: admin with age >= 30
        await users.create({ ...testData.user.valid(), name: 'Alice', role: 'admin', age: 30 })
        // Should not match: admin with age < 30
        await users.create({ ...testData.user.valid(), name: 'Bob', role: 'admin', age: 20 })
        // Should match: user with name 'Charlie'
        await users.create({ ...testData.user.valid(), name: 'Charlie', role: 'user', age: 25 })
        // Should not match: user without name 'Charlie'
        await users.create({ ...testData.user.valid(), name: 'Dave', role: 'user', age: 35 })

        const results = await users.query()
          .where(e => e.or(
            e.and(e.eq('role', 'admin'), e.gte('age', 25)),
            e.and(e.eq('role', 'user'), e.eq('name', 'Charlie')),
          ))
          .orderBy('name', 'ASC')
          .execute()

        expect(results.length).toBe(2)
        expect(results[0]?.name).toBe('Alice')
        expect(results[1]?.name).toBe('Charlie')
      })
    })
  })

  describe('Integration with QueryBuilder', () => {
    test('where with Expression instance directly', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice' })
        await users.create({ ...testData.user.valid(), name: 'Bob' })

        const e = users.query().expr()
        const results = await users.query()
          .where(e.eq('name', 'Alice'))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.name).toBe('Alice')
      })
    })

    test('orWhere with Expression instance', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice', role: 'admin' })
        await users.create({ ...testData.user.valid(), name: 'Bob', role: 'user' })
        await users.create({ ...testData.user.valid(), name: 'Charlie', role: 'moderator' })

        const results = await users.query()
          .where('name', '=', 'Alice')
          .orWhere(e => e.eq('name', 'Bob'))
          .orderBy('name', 'ASC')
          .execute()

        expect(results.length).toBe(2)
        expect(results[0]?.name).toBe('Alice')
        expect(results[1]?.name).toBe('Bob')
      })
    })

    test('orWhere with complex expression', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice', role: 'admin', age: 30 })
        await users.create({ ...testData.user.valid(), name: 'Bob', role: 'user', age: 25 })
        await users.create({ ...testData.user.valid(), name: 'Charlie', role: 'moderator', age: 20 })

        const results = await users.query()
          .where('role', '=', 'admin')
          .orWhere(e => e.and(
            e.eq('role', 'user'),
            e.gte('age', 25),
          ))
          .orderBy('name', 'ASC')
          .execute()

        expect(results.length).toBe(2)
        expect(results[0]?.name).toBe('Alice')
        expect(results[1]?.name).toBe('Bob')
      })
    })

    test('chaining expressions with regular where', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice', role: 'admin', age: 30 })
        await users.create({ ...testData.user.valid(), name: 'Bob', role: 'admin', age: 20 })
        await users.create({ ...testData.user.valid(), name: 'Charlie', role: 'user', age: 30 })

        const results = await users.query()
          .where(e => e.eq('role', 'admin'))
          .where('age', '>=', 25)
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.name).toBe('Alice')
      })
    })

    test('repo.expr() creates ExpressionBuilder', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice' })
        await users.create({ ...testData.user.valid(), name: 'Bob' })

        const e = users.expr()
        const results = await users.query()
          .where(e.eq('name', 'Bob'))
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.name).toBe('Bob')
      })
    })
  })
})
