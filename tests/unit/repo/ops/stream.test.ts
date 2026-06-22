import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../../src/index'
import { setupReadPipeline as setup } from './_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

describe('stream pipeline', () => {
  it('yields rows across LIMIT/OFFSET chunks until empty', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
    exec.preset([{ id: 3, name: 'C' }])
    exec.preset([])

    const collected: { id: number, name: string }[] = []

    for await (const row of pipeline.stream(undefined, { chunkSize: 2, unsafe: true })) {
      collected.push(row as { id: number, name: string })
    }

    expect(collected).toHaveLength(3)
    expect(collected[0]).toEqual({ id: 1, name: 'A' })
  })

  it('stops early when a chunk returns fewer rows than chunkSize', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, name: 'A' }]) // 1 row < chunkSize=2 → stop after one fetch

    const collected: unknown[] = []

    for await (const row of pipeline.stream(undefined, { chunkSize: 2, unsafe: true }))
      collected.push(row)

    expect(collected).toHaveLength(1)
    expect(exec.queries).toHaveLength(1)
  })
})

describe('streamCursor pipeline', () => {
  it('yields rows across keyset pages until nextCursor is null', async () => {
    const { exec, pipeline } = setup(users)

    // page 1: take+1=3 rows so nextCursor=2
    exec.preset([{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }])
    // page 2: 1 row so nextCursor=null
    exec.preset([{ id: 3, name: 'C' }])

    const collected: { id: number }[] = []

    for await (const row of pipeline.streamCursor({ chunkSize: 2 }))
      collected.push(row as { id: number })

    expect(collected.map(r => r.id)).toEqual([1, 2, 3])
  })
})
