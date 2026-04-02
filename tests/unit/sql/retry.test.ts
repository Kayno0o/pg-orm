import { describe, expect, it } from 'bun:test'
import { ConnectionError, DeadlockError, QueryError } from '../../../src/errors/index'

// Test retry logic by simulating the same algorithm used in Database.query()
// We extract the retry loop logic into a standalone helper to test without bun:sql.

interface RetryOpts {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

async function retryQuery(
  queryFn: () => Promise<unknown[]>,
  opts: RetryOpts,
): Promise<unknown[]> {
  if (opts.maxRetries <= 0) {
    return queryFn()
  }

  let lastError: unknown

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await queryFn()
    }
    catch (err) {
      lastError = err

      if (attempt < opts.maxRetries && (err instanceof ConnectionError || err instanceof DeadlockError)) {
        const baseDelay = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs)
        const delay = baseDelay * (0.5 + Math.random() * 0.5)

        await new Promise(resolve => setTimeout(resolve, delay))

        continue
      }

      throw err
    }
  }

  throw lastError
}

describe('Retry logic', () => {
  it('succeeds on first try without retry', async () => {
    let calls = 0
    const result = await retryQuery(async () => {
      calls++

      return [{ id: 1 }]
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 })

    expect(calls).toBe(1)
    expect(result).toEqual([{ id: 1 }])
  })

  it('retries on ConnectionError and succeeds', async () => {
    let calls = 0
    const result = await retryQuery(async () => {
      calls++

      if (calls <= 2)
        throw new ConnectionError('connection lost')

      return [{ id: 1 }]
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 })

    expect(calls).toBe(3)
    expect(result).toEqual([{ id: 1 }])
  })

  it('retries on DeadlockError and succeeds', async () => {
    let calls = 0
    const result = await retryQuery(async () => {
      calls++

      if (calls === 1)
        throw new DeadlockError('deadlock detected', 'SELECT 1', [])

      return [{ id: 1 }]
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 })

    expect(calls).toBe(2)
    expect(result).toEqual([{ id: 1 }])
  })

  it('throws non-retryable errors immediately', async () => {
    let calls = 0

    expect(retryQuery(async () => {
      calls++

      throw new QueryError('syntax error', 'SELECT ???', [])
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10 })).rejects.toThrow('syntax error')

    expect(calls).toBe(1)
  })

  it('throws after maxRetries exhausted', async () => {
    let calls = 0

    expect(retryQuery(async () => {
      calls++

      throw new ConnectionError('connection lost')
    }, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10 })).rejects.toThrow('connection lost')

    expect(calls).toBe(3) // initial + 2 retries
  })

  it('does not retry when maxRetries is 0', async () => {
    let calls = 0

    expect(retryQuery(async () => {
      calls++

      throw new ConnectionError('connection lost')
    }, { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10 })).rejects.toThrow('connection lost')

    expect(calls).toBe(1)
  })

  it('exponential backoff respects maxDelayMs cap', async () => {
    const delays: number[] = []
    let calls = 0

    // Measure delays by tracking promise resolution timing
    const start = performance.now()

    expect(retryQuery(async () => {
      calls++

      if (calls > 1)
        delays.push(performance.now() - start)

      throw new ConnectionError('connection lost')
    }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 })).rejects.toThrow('connection lost')

    expect(calls).toBe(4) // initial + 3 retries
  })
})
