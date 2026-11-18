import { describe, expect, it } from 'bun:test'
import { ValidationError } from '../../../../src/errors/index'
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

    for await (const row of pipeline.stream(undefined, { chunkSize: 2, warn: false })) {
      collected.push(row as { id: number, name: string })
    }

    expect(collected).toHaveLength(3)
    expect(collected[0]).toEqual({ id: 1, name: 'A' })
  })

  it('refuses a chunkSize that is not a whole number of 1 or more', async () => {
    const { exec, pipeline } = setup(users)

    for (const chunkSize of [-1, 0, 1.5, Number.NaN]) {
      await expect((async () => {
        for await (const _row of pipeline.stream(undefined, { chunkSize, warn: false }));
      })(), String(chunkSize)).rejects.toBeInstanceOf(ValidationError)
    }

    expect(exec.queries).toHaveLength(0)
  })

  it('reads within the limit and offset its callback set, in chunks', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 2, name: 'B' }, { id: 3, name: 'C' }])
    exec.preset([{ id: 4, name: 'D' }])

    const collected: unknown[] = []

    for await (const row of pipeline.stream(q => q.limit(3).offset(1), { chunkSize: 2, warn: false }))
      collected.push(row)

    expect(collected).toHaveLength(3)
    expect(exec.queries.map(q => q.params)).toEqual([[2, 1], [1, 3]])
  })

  it('stops early when a chunk returns fewer rows than chunkSize', async () => {
    const { exec, pipeline } = setup(users)

    exec.preset([{ id: 1, name: 'A' }]) // 1 row < chunkSize=2 → stop after one fetch

    const collected: unknown[] = []

    for await (const row of pipeline.stream(undefined, { chunkSize: 2, warn: false }))
      collected.push(row)

    expect(collected).toHaveLength(1)
    expect(exec.queries).toHaveLength(1)
  })
})

describe('stream.offset scopes', () => {
  const scoped = defineTable('docs', t => ({
    id: t.serial().primaryKey(),
    tenant: t.text().notNull(),
  })).withScope('tenant', e => e.eq('tenant', 'acme'))

  async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
    for await (const _row of stream);
  }

  it('carries the scopes and lifts one by name, in the options', async () => {
    const { exec, pipeline } = setup(scoped)

    await drain(pipeline.stream(undefined, { warn: false }))
    expect(exec.lastQuery!.sql).toContain('"tenant" = $')

    await drain(pipeline.stream({ id: 1 }, { warn: false, withoutScopes: ['tenant'] }))
    expect(exec.lastQuery!.sql).not.toContain('"tenant"')
  })
})

describe('stream.offset warning', () => {
  interface Notice { kind: string, error: Error }

  function listening(exec: object): Notice[] {
    const notices: Notice[] = []

    Object.assign(exec, { _onCallbackError: (event: Notice) => notices.push(event) })

    return notices
  }

  async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
    for await (const _row of stream);
  }

  it('warns once per database, however many repositories stream', async () => {
    const first = setup(users)
    const second = setup(users)
    const notices = listening(first.exec)
    const shared = new Set<string>()

    Object.assign(first.exec, { _notices: shared })
    Object.assign(second.exec, { _notices: shared, _onCallbackError: (event: Notice) => notices.push(event) })

    await drain(first.pipeline.stream())
    await drain(second.pipeline.stream())
    expect(notices).toHaveLength(1)
    expect(notices[0]!.error.message).toContain('warn: false')
  })

  it('warns again for a second database', async () => {
    const first = setup(users)
    const second = setup(users)
    const notices = listening(first.exec)

    Object.assign(first.exec, { _notices: new Set<string>() })
    Object.assign(second.exec, { _notices: new Set<string>(), _onCallbackError: (event: Notice) => notices.push(event) })

    await drain(first.pipeline.stream())
    await drain(second.pipeline.stream())
    expect(notices).toHaveLength(2)
  })

  it('stays silent with warn: false', async () => {
    const { exec, pipeline } = setup(users)
    const notices = listening(exec)

    await drain(pipeline.stream(undefined, { warn: false }))
    expect(notices).toHaveLength(0)
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
