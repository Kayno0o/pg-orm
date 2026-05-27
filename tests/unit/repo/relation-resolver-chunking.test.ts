import { describe, expect, test } from 'bun:test'
import { ChunkedQueryExecutor } from '../../../src/repo/chunked-executor'
import { MockExecutor } from '../../helpers/mock-executor'

// Tests the chunking boundary semantics that `RelationResolver` relies on.
// The boundary cases here are the same ones a future `RelationResolver` test
// would assert against, just exercised through the underlying primitive.

function buildSql(chunk: unknown[]) {
  return { sql: `SELECT * FROM t WHERE id IN (${chunk.map((_, i) => `$${i + 1}`).join(', ')})`, params: chunk }
}

describe('ChunkedQueryExecutor', () => {
  test('empty ids → executor never called', async () => {
    const exec = new MockExecutor()
    const c = new ChunkedQueryExecutor(exec, 10)

    const rows = await c.execute([], buildSql)

    expect(rows).toEqual([])
    expect(exec.queries.length).toBe(0)
  })

  test('single id → one call with single-element chunk', async () => {
    const exec = new MockExecutor()

    exec.preset([{ id: 42 }])

    const c = new ChunkedQueryExecutor(exec, 10)
    const rows = await c.execute([42], buildSql)

    expect(rows).toEqual([{ id: 42 }])
    expect(exec.queries.length).toBe(1)
    expect(exec.queries[0]!.params).toEqual([42])
  })

  test('ids.length === chunkSize → exactly one call, no split', async () => {
    const exec = new MockExecutor()

    exec.preset([{ id: 1 }, { id: 2 }, { id: 3 }])

    const c = new ChunkedQueryExecutor(exec, 3)
    const rows = await c.execute([1, 2, 3], buildSql)

    expect(rows).toHaveLength(3)
    expect(exec.queries.length).toBe(1)
    expect(exec.queries[0]!.params).toEqual([1, 2, 3])
  })

  test('ids.length === chunkSize + 1 → two calls, sizes [chunkSize, 1]', async () => {
    const exec = new MockExecutor()

    exec.preset([{ id: 1 }, { id: 2 }, { id: 3 }])
    exec.preset([{ id: 4 }])

    const c = new ChunkedQueryExecutor(exec, 3)
    const rows = await c.execute([1, 2, 3, 4], buildSql)

    expect(rows).toHaveLength(4)
    expect(exec.queries.length).toBe(2)
    expect(exec.queries[0]!.params).toEqual([1, 2, 3])
    expect(exec.queries[1]!.params).toEqual([4])
  })

  test('ids.length === chunkSize * 3 → exactly three calls of size chunkSize', async () => {
    const exec = new MockExecutor()

    for (let i = 0; i < 3; i++)
      exec.preset([{ batch: i }])

    const c = new ChunkedQueryExecutor(exec, 2)
    const ids = [1, 2, 3, 4, 5, 6]
    const rows = await c.execute(ids, buildSql)

    expect(rows).toHaveLength(3)
    expect(exec.queries.length).toBe(3)
    expect(exec.queries[0]!.params).toEqual([1, 2])
    expect(exec.queries[1]!.params).toEqual([3, 4])
    expect(exec.queries[2]!.params).toEqual([5, 6])
  })

  test('buildSql receives the correct chunk slice per call', async () => {
    const exec = new MockExecutor()

    exec.preset([])
    exec.preset([])

    const chunksSeen: unknown[][] = []
    const c = new ChunkedQueryExecutor(exec, 2)

    await c.execute([10, 20, 30], (chunk) => {
      chunksSeen.push([...chunk])

      return buildSql(chunk)
    })

    expect(chunksSeen).toEqual([[10, 20], [30]])
  })

  test('concatenates rows across chunks in order', async () => {
    const exec = new MockExecutor()

    exec.preset([{ id: 1 }, { id: 2 }])
    exec.preset([{ id: 3 }])

    const c = new ChunkedQueryExecutor(exec, 2)
    const rows = await c.execute([1, 2, 3], buildSql)

    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })
})
