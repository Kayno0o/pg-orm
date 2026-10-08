import { describe, expect, test } from 'bun:test'
import { defineTable } from '../../../src/index'
import { RelationResolver } from '../../../src/repo/relation-resolver'
import { MockExecutor } from '../../helpers/mock-executor'

// Tests the chunking boundary semantics of `RelationResolver` (which now owns
// the chunked-query loop internally). We use a simple hasMany relation and
// drive `loadIncludes` with different parent-row counts to assert how the IDs
// are split into chunks before reaching the executor.

interface Child {
  id: number
  parentId: number
}

const parentsTable = defineTable('parents', t => ({
  id: t.int4().primaryKey(),
})).withRelations(r => ({
  children: r.hasMany<Child>('children', 'parentId'),
}))

const includes = [{ relation: 'children' as const, strategy: 'batch' as const, callback: undefined }]

function makeResolver(exec: MockExecutor, chunkSize: number): RelationResolver {
  return new RelationResolver(parentsTable, exec, 5, chunkSize)
}

function parents(...ids: number[]): Record<string, unknown>[] {
  return ids.map(id => ({ id }))
}

describe('RelationResolver chunking', () => {
  test('an unknown relation throws rather than being skipped', async () => {
    const r = makeResolver(new MockExecutor(), 10)

    expect(r.loadIncludes(parents(1), [{ relation: 'childs', strategy: 'batch', callback: undefined }])).rejects.toThrow('"parents" has no relation "childs"')
  })

  test('empty parent rows → executor never called', async () => {
    const exec = new MockExecutor()
    const r = makeResolver(exec, 10)

    await r.loadIncludes([], includes)
    expect(exec.queries.length).toBe(0)
  })

  test('single parent id → one call with single-element chunk', async () => {
    const exec = new MockExecutor()

    exec.preset([{ id: 100, parentId: 1 }])

    const r = makeResolver(exec, 10)

    await r.loadIncludes(parents(1), includes)
    expect(exec.queries.length).toBe(1)
    expect(exec.queries[0]!.params).toEqual([[1]])
  })

  test('parent ids === chunkSize → exactly one call, no split', async () => {
    const exec = new MockExecutor()

    exec.preset([])

    const r = makeResolver(exec, 3)

    await r.loadIncludes(parents(1, 2, 3), includes)
    expect(exec.queries.length).toBe(1)
    expect(exec.queries[0]!.params).toEqual([[1, 2, 3]])
  })

  test('parent ids === chunkSize + 1 → two calls, sizes [chunkSize, 1]', async () => {
    const exec = new MockExecutor()

    exec.preset([])
    exec.preset([])

    const r = makeResolver(exec, 3)

    await r.loadIncludes(parents(1, 2, 3, 4), includes)
    expect(exec.queries.length).toBe(2)
    expect(exec.queries[0]!.params).toEqual([[1, 2, 3]])
    expect(exec.queries[1]!.params).toEqual([[4]])
  })

  test('parent ids === chunkSize * 3 → exactly three calls', async () => {
    const exec = new MockExecutor()

    for (let i = 0; i < 3; i++) exec.preset([])

    const r = makeResolver(exec, 2)

    await r.loadIncludes(parents(1, 2, 3, 4, 5, 6), includes)
    expect(exec.queries.length).toBe(3)
    expect(exec.queries[0]!.params).toEqual([[1, 2]])
    expect(exec.queries[1]!.params).toEqual([[3, 4]])
    expect(exec.queries[2]!.params).toEqual([[5, 6]])
  })

  test('deduplicates parent ids before chunking', async () => {
    const exec = new MockExecutor()

    exec.preset([])

    const r = makeResolver(exec, 10)

    await r.loadIncludes(parents(1, 1, 2, 2, 3), includes)
    expect(exec.queries.length).toBe(1)
    expect(exec.queries[0]!.params).toEqual([[1, 2, 3]])
  })

  test('concatenates rows across chunks and groups them under the parent', async () => {
    const exec = new MockExecutor()

    exec.preset([{ id: 100, parentId: 1 }, { id: 101, parentId: 2 }])
    exec.preset([{ id: 102, parentId: 3 }])

    const r = makeResolver(exec, 2)
    const rows = parents(1, 2, 3)

    await r.loadIncludes(rows, includes)
    expect(exec.queries.length).toBe(2)
    expect(rows[0]!.children).toEqual([{ id: 100, parentId: 1 }])
    expect(rows[1]!.children).toEqual([{ id: 101, parentId: 2 }])
    expect(rows[2]!.children).toEqual([{ id: 102, parentId: 3 }])
  })
})
