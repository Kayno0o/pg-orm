import type { MigrationOp } from '../../../src/migration/types'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { MigrationError } from '../../../src/errors/index'
import { promptSync } from '../../../src/migration/interactive'

function op(overrides: Partial<MigrationOp> = {}): MigrationOp {
  return {
    type: 'create_table',
    sql: 'CREATE TABLE foo()',
    description: 'create table foo',
    destructive: false,
    ...overrides,
  }
}

describe('promptSync', () => {
  const origLog = console.log
  const logged: string[] = []

  beforeEach(() => {
    logged.length = 0
    console.log = mock((...args: unknown[]) => {
      logged.push(args.join(' '))
    })
  })

  afterEach(() => {
    console.log = origLog
  })

  it('returns true on explicit "y"', async () => {
    const ok = await promptSync([op()], [], async () => 'y')

    expect(ok).toBe(true)
  })

  it('returns true on "yes" (case insensitive)', async () => {
    expect(await promptSync([op()], [], async () => 'YES')).toBe(true)
    expect(await promptSync([op()], [], async () => 'Yes')).toBe(true)
  })

  it('returns true on empty answer when no destructive ops (default Y)', async () => {
    const ok = await promptSync([op()], [], async () => '')

    expect(ok).toBe(true)
  })

  it('returns false on empty answer when destructive ops present (default N)', async () => {
    const destructive = op({ destructive: true, sql: 'DROP TABLE foo' })
    const ok = await promptSync([destructive], [destructive], async () => '')

    expect(ok).toBe(false)
  })

  it('returns false on "n"', async () => {
    const ok = await promptSync([op()], [], async () => 'n')

    expect(ok).toBe(false)
  })

  it('returns false on arbitrary non-yes input', async () => {
    expect(await promptSync([op()], [], async () => 'maybe')).toBe(false)
    expect(await promptSync([op()], [], async () => 'whatever')).toBe(false)
  })

  it('trims whitespace and lowercases before comparing', async () => {
    expect(await promptSync([op()], [], async () => '  Y  ')).toBe(true)
    expect(await promptSync([op()], [], async () => '\tyes\n')).toBe(true)
  })

  it('logs preview of safe operations', async () => {
    await promptSync([op({ description: 'create users table' })], [], async () => 'y')

    const joined = logged.join('\n')

    expect(joined).toContain('safe operation(s)')
    expect(joined).toContain('create users table')
  })

  it('logs preview of destructive operations separately', async () => {
    const drop = op({ description: 'drop users table', destructive: true })

    await promptSync([drop], [drop], async () => 'y')

    const joined = logged.join('\n')

    expect(joined).toContain('destructive operation(s)')
    expect(joined).toContain('drop users table')
  })

  it('logs SQL to execute for each op', async () => {
    await promptSync(
      [op({ sql: 'CREATE TABLE a()' }), op({ sql: 'CREATE TABLE b()' })],
      [],
      async () => 'y',
    )

    const joined = logged.join('\n')

    expect(joined).toContain('CREATE TABLE a()')
    expect(joined).toContain('CREATE TABLE b()')
  })

  it('logs "Sync cancelled." when user declines', async () => {
    await promptSync([op()], [], async () => 'n')

    expect(logged.some(l => l.includes('Sync cancelled.'))).toBe(true)
  })

  it('passes the prompt text to the reader (includes destructive count)', async () => {
    let receivedPrompt = ''
    const destructive = op({ destructive: true })

    await promptSync([destructive, destructive], [destructive], async (p) => {
      receivedPrompt = p

      return 'y'
    })

    expect(receivedPrompt).toContain('2 operation(s)')
    expect(receivedPrompt).toContain('1 destructive')
    expect(receivedPrompt).toContain('[y/N]')
  })

  it('uses [Y/n] prompt when no destructive ops', async () => {
    let receivedPrompt = ''

    await promptSync([op(), op()], [], async (p) => {
      receivedPrompt = p

      return 'y'
    })

    expect(receivedPrompt).toContain('[Y/n]')
    expect(receivedPrompt).not.toContain('destructive')
  })

  it('answers no when stdin ends unanswered, even where an empty answer is yes', async () => {
    expect(await promptSync([op()], [], async () => null)).toBe(false)
  })

  it('refuses before printing anything when stdin is not a terminal and no reader is given', async () => {
    const tty = process.stdin.isTTY

    process.stdin.isTTY = false

    try {
      await expect(promptSync([op()], [])).rejects.toBeInstanceOf(MigrationError)
      expect(logged).toEqual([])
    }
    finally {
      process.stdin.isTTY = tty
    }
  })

  it('the default reader answers no on a closed stdin instead of waiting forever', async () => {
    const module = JSON.stringify(resolve(import.meta.dir, '../../../src/migration/interactive.ts'))
    const proc = Bun.spawn(['bun', '-e', `process.stdin.isTTY = true; const { promptSync } = await import(${module}); console.error(await promptSync([{ type: 'create_table', sql: 'SELECT 1', description: 'x', destructive: false }], []))`], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' })
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

    expect(code).toBe(0)
    expect(err.trim()).toBe('false')
  }, 10_000)
})
