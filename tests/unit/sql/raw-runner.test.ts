import { describe, expect, it } from 'bun:test'
import { RawRunner } from '../../../src/sql/raw-runner'

interface Recorded {
  sql: string
  params: unknown[]
}

function makeRecorder(rows: Record<string, unknown>[] = []) {
  const calls: Recorded[] = []
  const runner = new RawRunner(async (sql, params) => {
    calls.push({ sql, params })

    return rows
  })

  return { runner, calls }
}

describe('RawRunner', () => {
  it('passes a plain SQL string through verbatim', async () => {
    const { runner, calls } = makeRecorder([{ id: 1 }])
    const rows = await runner.run<{ id: number }>('SELECT * FROM users WHERE id = $1', [42])

    expect(rows).toEqual([{ id: 1 }])
    expect(calls).toEqual([{ sql: 'SELECT * FROM users WHERE id = $1', params: [42] }])
  })

  it('defaults the params array to [] when omitted on the plain-string form', async () => {
    const { runner, calls } = makeRecorder()

    await runner.run('SELECT 1')

    expect(calls[0]?.params).toEqual([])
  })

  it('assembles $N placeholders from a tagged template', async () => {
    const { runner, calls } = makeRecorder()
    const id = 7
    const name = 'alice'

    await runner.run`SELECT * FROM users WHERE id = ${id} AND name = ${name}`

    expect(calls[0]?.sql).toBe('SELECT * FROM users WHERE id = $1 AND name = $2')
    expect(calls[0]?.params).toEqual([7, 'alice'])
  })

  it('handles a template with no interpolations', async () => {
    const { runner, calls } = makeRecorder()

    await runner.run`SELECT 1`

    expect(calls[0]?.sql).toBe('SELECT 1')
    expect(calls[0]?.params).toEqual([])
  })

  it('handles trailing template text after the last interpolation', async () => {
    const { runner, calls } = makeRecorder()
    const limit = 10

    await runner.run`SELECT * FROM users LIMIT ${limit} OFFSET 0`

    expect(calls[0]?.sql).toBe('SELECT * FROM users LIMIT $1 OFFSET 0')
    expect(calls[0]?.params).toEqual([10])
  })

  it('preserves mixed types in template params (string, number, null)', async () => {
    const { runner, calls } = makeRecorder()

    await runner.run`INSERT INTO t (a, b, c) VALUES (${'x'}, ${42}, ${null})`

    expect(calls[0]?.params).toEqual(['x', 42, null])
  })

  it('forwards driver rows through the generic return type', async () => {
    const { runner } = makeRecorder([{ ok: true }])
    const out = await runner.run<{ ok: boolean }>('SELECT true AS ok', [])

    expect(out[0]?.ok).toBe(true)
  })
})
