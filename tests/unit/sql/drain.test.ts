import { describe, expect, it } from 'bun:test'
import { DrainCoordinator } from '../../../src/sql/drain'

describe('DrainCoordinator', () => {
  it('exit() without a matching enter() does not push inFlight below zero', () => {
    const drain = new DrainCoordinator()
    const events: { inFlight: number }[] = []

    drain.setImbalanceHandler(e => events.push(e))

    drain.exit()
    drain.exit()

    expect(drain.inFlight).toBe(0)
    expect(events).toHaveLength(2)
    expect(events[0]!.inFlight).toBe(0)
  })

  it('a balanced enter()/exit() pair leaves inFlight at zero with no imbalance', () => {
    const drain = new DrainCoordinator()
    let imbalances = 0

    drain.setImbalanceHandler(() => imbalances++)

    drain.enter()
    drain.exit()

    expect(drain.inFlight).toBe(0)
    expect(imbalances).toBe(0)
  })

  it('still resolves waitForIdle() after an unbalanced exit', async () => {
    const drain = new DrainCoordinator()

    let _ignored = 0

    drain.setImbalanceHandler(() => {
      _ignored++
    })

    drain.exit() // imbalance — ignored
    drain.enter()
    drain.enter()

    const idle = drain.waitForIdle(1000)

    drain.exit()
    drain.exit()

    await idle

    expect(drain.inFlight).toBe(0)
  })

  it('falls back to console.warn when no imbalance handler is set', () => {
    const drain = new DrainCoordinator()
    const original = console.warn
    const warnings: unknown[][] = []

    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      drain.exit()
    }
    finally {
      console.warn = original
    }

    expect(warnings.length).toBe(1)
    expect(String(warnings[0]![0])).toContain('DrainCoordinator')
  })
})
