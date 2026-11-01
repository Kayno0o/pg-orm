import type { Terminal } from '@kaynooo/cli-kit/prompt'
import type { MigrationOp } from '../../../src/migration/types'
import { EventEmitter } from 'node:events'
import { stripAnsi } from '@kaynooo/cli-kit'
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

// A raw-mode terminal sending `keys` once the prompt listens, then ending stdin when `end` is set; `drawn` is what the prompt wrote, colours stripped.
function terminal(keys: string[], { tty = true, end = false } = {}) {
  const input = new EventEmitter()
  const drawn: string[] = []
  const fake = {
    stdin: Object.assign(input, {
      isTTY: tty,
      setRawMode: () => undefined,
      resume: () => {
        queueMicrotask(() => {
          for (const key of keys)
            input.emit('data', Buffer.from(key))

          if (end)
            input.emit('end')
        })
      },
      pause: () => undefined,
    }),
    stderr: { isTTY: tty, columns: 120, rows: 24, write: (text: string) => drawn.push(stripAnsi(text)) },
  } as unknown as Terminal

  return { fake, drawn, listeners: () => input.listenerCount('data') }
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

  it('returns true on "y", whatever the case', async () => {
    expect(await promptSync([op()], [], terminal(['y']).fake)).toBe(true)
    expect(await promptSync([op()], [], terminal(['Y']).fake)).toBe(true)
  })

  it('returns true on Enter when no destructive ops (default Y)', async () => {
    expect(await promptSync([op()], [], terminal(['\r']).fake)).toBe(true)
  })

  it('returns false on Enter when destructive ops present (default N)', async () => {
    const destructive = op({ destructive: true, sql: 'DROP TABLE foo' })

    expect(await promptSync([destructive], [destructive], terminal(['\r']).fake)).toBe(false)
  })

  it('returns false on "n", other keys ignored until then', async () => {
    expect(await promptSync([op()], [], terminal(['n']).fake)).toBe(false)
    expect(await promptSync([op()], [], terminal(['x', 'q', 'n']).fake)).toBe(false)
  })

  it('returns false once Escape or Ctrl+C cancels', async () => {
    expect(await promptSync([op()], [], terminal(['\x1B']).fake)).toBe(false)
    expect(await promptSync([op()], [], terminal(['\x03']).fake)).toBe(false)
  })

  it('logs preview of safe operations', async () => {
    await promptSync([op({ description: 'create users table' })], [], terminal(['y']).fake)

    const joined = logged.join('\n')

    expect(joined).toContain('safe operation(s)')
    expect(joined).toContain('create users table')
  })

  it('logs preview of destructive operations separately', async () => {
    const drop = op({ description: 'drop users table', destructive: true })

    await promptSync([drop], [drop], terminal(['y']).fake)

    const joined = logged.join('\n')

    expect(joined).toContain('destructive operation(s)')
    expect(joined).toContain('drop users table')
  })

  it('logs SQL to execute for each op', async () => {
    await promptSync([op({ sql: 'CREATE TABLE a()' }), op({ sql: 'CREATE TABLE b()' })], [], terminal(['y']).fake)

    const joined = logged.join('\n')

    expect(joined).toContain('CREATE TABLE a()')
    expect(joined).toContain('CREATE TABLE b()')
  })

  it('logs "Sync cancelled." when user declines', async () => {
    await promptSync([op()], [], terminal(['n']).fake)

    expect(logged.some(l => l.includes('Sync cancelled.'))).toBe(true)
  })

  it('asks with the op and destructive counts, Enter meaning no', async () => {
    const destructive = op({ destructive: true })
    const { fake, drawn } = terminal(['y'])

    await promptSync([destructive, destructive], [destructive], fake)

    expect(drawn[1]).toEndWith('? Apply 2 operation(s) (1 destructive)? (y/N)')
  })

  it('asks without a destructive count when there is none, Enter meaning yes', async () => {
    const { fake, drawn } = terminal(['y'])

    await promptSync([op(), op()], [], fake)

    expect(drawn[1]).toEndWith('? Apply 2 operation(s)? (Y/n)')
  })

  it('answers no when stdin ends unanswered, even where Enter is yes, and stops listening', async () => {
    const { fake, listeners } = terminal([], { end: true })

    expect(await promptSync([op()], [], fake)).toBe(false)
    expect(listeners()).toBe(0)
  })

  it('refuses before printing anything when stdin is not a terminal', async () => {
    let refused: unknown

    try {
      await promptSync([op()], [], terminal([], { tty: false }).fake)
    }
    catch (error) {
      refused = error
    }

    expect(refused).toBeInstanceOf(MigrationError)
    expect(logged).toEqual([])
  })
})
