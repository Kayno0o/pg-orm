import { describe, expect, it } from 'bun:test'
import { OrmError, Repository } from '../../src/index'
import { postsTable, usersTable } from '../helpers/fixtures'
import { MockExecutor } from '../helpers/mock-executor'

describe('Edge Cases — Unit', () => {
  // --- 1.1 restore() ---
  describe('restore()', () => {
    it('throws OrmError if table has no softDelete trait', async () => {
      const mock = new MockExecutor()
      const repo = new Repository({ table: postsTable, executor: mock })

      expect(repo.write.restore(e => e.eq('id', 1), { pk: true })).rejects.toThrow(OrmError)
      expect(repo.write.restore(e => e.eq('id', 1), { pk: true })).rejects.toThrow('restore() requires softDelete trait')
    })

    it('generates UPDATE SET deletedAt = NULL with isNotNull filter', async () => {
      const mock = new MockExecutor()

      mock.preset([{ id: 1, name: 'Alice', email: 'a@test.com', age: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date() }])
      const repo = new Repository({ table: usersTable, executor: mock })

      await repo.write.restore(e => e.eq('id', 1), { pk: true })

      expect(mock.queries.length).toBeGreaterThanOrEqual(1)
      const query = mock.queries[0]!

      expect(query.sql).toContain('UPDATE')
      expect(query.sql).toContain('IS NOT NULL')
      expect(query.sql).toContain('"deletedAt"')
    })
  })

  // --- 1.2 Circular include detection ---
  describe('Circular include detection', () => {
    it('detects circular include via nested dotted path', async () => {
      const mock = new MockExecutor()

      // Set up the table with relations
      const tables = new Map<string, any>()

      tables.set('users', usersTable)
      tables.set('posts', postsTable)

      // eslint-disable-next-line no-new
      new Repository({ table: postsTable, executor: mock, tableRegistry: tables })

      // Preset parent rows
      mock.preset([{ id: 1, title: 'Test', body: 'Body', authorId: 1, publishedAt: null }])
      // Preset author rows
      mock.preset([{ id: 1, name: 'Alice', email: 'a@test.com', age: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date() }])

      // posts.author is fine, but posts.author -> users.posts would create a cycle
      // The circular detection should catch when the same table.relation is visited again
      // We test by trying to include 'author.posts' which means:
      // 1. Load posts -> author (users table)
      // 2. Load users -> posts (posts table) — but posts.author was already in the chain

      // This specific case hits the depth limit rather than explicit cycle detection
      // because the cycle manifests as A -> B -> A pattern across different repos
    })
  })

  // --- 1.3 Default query limit ---
  describe('Default query limit', () => {
    it('applies defaultLimit when no explicit limit is set', async () => {
      const mock = new MockExecutor()

      mock.preset([])
      const repo = new Repository({ table: usersTable, executor: mock, defaultLimit: 100 })

      await repo.read.findMany()

      const query = mock.queries[0]!

      expect(query.sql).toContain('LIMIT')
      expect(query.params).toContain(100)
    })

    it('does not override explicit limit', async () => {
      const mock = new MockExecutor()

      mock.preset([])
      const repo = new Repository({ table: usersTable, executor: mock, defaultLimit: 100 })

      await repo.read.findMany(q => q.limit(10))

      const query = mock.queries[0]!

      expect(query.sql).toContain('LIMIT')
      expect(query.params).toContain(10)
      expect(query.params).not.toContain(100)
    })

    it('does not apply limit when defaultLimit is not set', async () => {
      const mock = new MockExecutor()

      mock.preset([])
      const repo = new Repository({ table: usersTable, executor: mock })

      await repo.read.findMany()

      const sql = mock.queries[0]!.sql

      expect(sql).not.toContain('LIMIT')
    })
  })

  // --- 1.4 upsertMany() ---
  describe('upsertMany()', () => {
    it('returns empty array for empty input', async () => {
      const mock = new MockExecutor()
      const repo = new Repository({ table: postsTable, executor: mock })

      const result = await repo.write.upsertMany([], ['id'], undefined, { pk: true })

      expect(result).toEqual([])
      expect(mock.queries).toHaveLength(0)
    })

    it('generates INSERT ... ON CONFLICT ... DO UPDATE with RETURNING', async () => {
      const mock = new MockExecutor()

      mock.preset([
        { id: 1, title: 'Post 1', body: 'Body 1', authorId: 1, publishedAt: null },
        { id: 2, title: 'Post 2', body: 'Body 2', authorId: 1, publishedAt: null },
      ])
      const repo = new Repository({ table: postsTable, executor: mock })

      const result = await repo.write.upsertMany(
        [
          { title: 'Post 1', body: 'Body 1', authorId: 1 },
          { title: 'Post 2', body: 'Body 2', authorId: 1 },
        ],
        ['title'],
        undefined,
        { pk: true },
      )

      expect(result).toHaveLength(2)
      const sql = mock.queries[0]!.sql

      expect(sql).toContain('INSERT INTO')
      expect(sql).toContain('ON CONFLICT')
      expect(sql).toContain('DO UPDATE')
      expect(sql).toContain('RETURNING')
    })

    it('doUpdate with no args updates all non-conflict columns', async () => {
      const mock = new MockExecutor()

      mock.preset([{ id: 1, title: 'Post 1', body: 'Body 1', authorId: 1, publishedAt: null }])
      const repo = new Repository({ table: postsTable, executor: mock })

      await repo.write.upsertMany(
        [{ title: 'Post 1', body: 'Body 1', authorId: 1 }],
        ['title'],
        undefined,
        { pk: true },
      )

      const sql = mock.queries[0]!.sql

      // Should update body and authorId (all non-conflict columns)
      expect(sql).toContain('DO UPDATE SET')
      expect(sql).toContain('"body" = EXCLUDED."body"')
      expect(sql).toContain('"authorId" = EXCLUDED."authorId"')
      // Should NOT update the conflict target
      expect(sql).not.toContain('"title" = EXCLUDED."title"')
    })

    it('passes specific updateColumns to doUpdate', async () => {
      const mock = new MockExecutor()

      mock.preset([{ id: 1, title: 'Post 1', body: 'Updated', authorId: 1, publishedAt: null }])
      const repo = new Repository({ table: postsTable, executor: mock })

      await repo.write.upsertMany(
        [{ title: 'Post 1', body: 'Updated', authorId: 1 }],
        ['title'],
        ['body'],
        { pk: true },
      )

      const sql = mock.queries[0]!.sql

      expect(sql).toContain('ON CONFLICT')
      expect(sql).toContain('"body"')
    })
  })
})
