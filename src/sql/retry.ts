import { ConnectionError, DeadlockError, SerializationError } from '../errors/index'

export interface RetryConfig {
  /** Maximum number of retry attempts (0 = disabled) */
  maxRetries: number
  /** Initial delay in milliseconds before first retry */
  baseDelayMs: number
  /** Maximum delay between retries in milliseconds */
  maxDelayMs: number
  /** Also retry a write after a dropped connection, which may have committed it already. */
  writes: boolean
}

// A statement starting with SELECT changes nothing, so running it again is harmless.
const READ_ONLY_RE = /^\s*select\b/i

/** Default predicate: transient connection drops and PG deadlocks. */
export function isRetryable(err: unknown): boolean {
  return err instanceof ConnectionError || err instanceof DeadlockError
}

/**
 * The retry predicate for one statement. A deadlock or serialization failure aborted the statement, so any statement retries.
 * A dropped connection may have committed it before the reply was lost, so only a read retries unless `retryWrites`.
 */
export function retryableFor(sql: string, retryWrites: boolean): (err: unknown) => boolean {
  const repeatable = retryWrites || READ_ONLY_RE.test(sql)

  return err => err instanceof DeadlockError || err instanceof SerializationError || (repeatable && err instanceof ConnectionError)
}

/** Exponential backoff with 50% jitter, clamped to maxDelay. */
export function computeBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const baseDelay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs)

  return baseDelay * (0.5 + Math.random() * 0.5)
}

/**
 * Run `fn` and retry up to `cfg.maxRetries` times on errors matching `retryable`.
 * Sleeps with `computeBackoff` between attempts. Throws the last error if all
 * attempts fail or the error isn't retryable.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  cfg: RetryConfig,
  retryable: (err: unknown) => boolean = isRetryable,
): Promise<T> {
  if (cfg.maxRetries <= 0) {
    return await fn()
  }

  let lastError: unknown

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn()
    }
    catch (err) {
      lastError = err

      if (attempt < cfg.maxRetries && retryable(err)) {
        const delay = computeBackoff(attempt, cfg.baseDelayMs, cfg.maxDelayMs)

        await new Promise(resolve => setTimeout(resolve, delay))

        continue
      }

      throw err
    }
  }

  throw lastError
}

/**
 * Stateful wrapper around `withRetry`. Created once per `Database` so call sites
 * don't have to thread `maxRetries`/`baseDelayMs`/`maxDelayMs` everywhere — they
 * just call `policy.run(fn)`.
 */
export class RetryPolicy {
  // `stopped` turns retrying off for good, once the pool is closing and a dropped connection is no longer transient.
  constructor(private readonly cfg: RetryConfig, private readonly stopped: () => boolean = () => false) {}

  run<T>(fn: () => Promise<T>, retryable: (err: unknown) => boolean = isRetryable): Promise<T> {
    return withRetry(fn, this.cfg, err => !this.stopped() && retryable(err))
  }

  /** Run one SQL statement, retrying only what `retryableFor` allows for it. */
  runStatement<T>(sql: string, fn: () => Promise<T>): Promise<T> {
    return this.run(fn, retryableFor(sql, this.cfg.writes))
  }
}
