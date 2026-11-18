import type { AnyTableDef } from '../../src/index'
import { describe, expect, it } from 'bun:test'
import { defineTable, embedding, OrmError, Repository, softDelete, ValidationError } from '../../src/index'
import { postsTable, usersTable } from '../helpers/fixtures'
import { MockExecutor } from '../helpers/mock-executor'

describe('include(relation, callback)', () => {
  it('types the callback from the relation\'s table and runs it on the related rows', async () => {
    const mock = new MockExecutor()

    mock.preset([{ id: 1, authorId: 7 }])
    mock.preset([{ id: 7, name: 'Ada' }])
    // @ts-expect-error title is a posts column, not a users one
    void new Repository<typeof postsTable.columns, typeof postsTable.relations>({ table: postsTable, executor: new MockExecutor() }).read.select().include('author', a => a.where({ title: 'x' }))

    const [post] = await new Repository<typeof postsTable.columns, typeof postsTable.relations>({ table: postsTable, executor: mock, tableRegistry: new Map<string, AnyTableDef>([['users', usersTable]]) }).read.findMany(q => q.include('author', a => a.where({ name: 'Ada' })))

    expect(mock.queries[1]!.sql).toContain('"name" = $')
    expect(post!.author).toMatchObject({ name: 'Ada' })
  })
})

describe('caller mistakes', () => {
  it('throw ValidationError: a missing trait, a repeated trait or scope, a wrong embedding column, a nested include past the limit, an executor without COPY', async () => {
    const plain = () => defineTable('cm', t => ({ id: t.serial().primaryKey(), body: t.text(), vec: t.vector(3) }))
    const repo = () => new Repository({ table: postsTable, executor: new MockExecutor() })
    const deep = new MockExecutor()

    deep.preset([{ id: 1, authorId: 1 }])
    deep.preset([{ id: 1 }])

    expect(() => plain().withTrait({ name: 'tagged' }).withTrait({ name: 'tagged' })).toThrow(ValidationError)
    expect(() => plain().withTrait({ name: 'other', scopes: { softDelete: e => e.isNull('id') } }).withTrait(softDelete())).toThrow(ValidationError)
    expect(() => plain().withTrait(embedding({ column: 'vec', source: row => row.body, embed: async () => [] }))).toThrow(ValidationError)
    await expect(repo().write.restore(e => e.eq('id', 1), { pk: true })).rejects.toThrow(ValidationError)
    await expect(repo().write.copyFrom([{ title: 'x' }])).rejects.toThrow(ValidationError)
    await expect(new Repository<typeof postsTable.columns, typeof postsTable.relations>({ table: postsTable, executor: new MockExecutor() }).read.findMany(q => q.include('author', postsTable, a => a))).rejects.toThrow(ValidationError)
    await expect(new Repository<typeof postsTable.columns, typeof postsTable.relations>({ table: postsTable, executor: deep, maxIncludeDepth: 0, tableRegistry: new Map<string, AnyTableDef>([['posts', postsTable], ['users', usersTable]]) }).read.findMany(q => q.include('author', usersTable, a => a.include('posts')))).rejects.toThrow(ValidationError)
  })
})

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

      const result = await repo.write.upsertMany([], ['id'], { pk: true })

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
        { update: ['body'], pk: true },
      )

      const sql = mock.queries[0]!.sql

      expect(sql).toContain('ON CONFLICT')
      expect(sql).toContain('"body"')
    })
  })
})
