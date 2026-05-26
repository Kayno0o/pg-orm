import { ConnectionError, DeadlockError } from '../errors/index'

export interface RetryConfig {
  /** Maximum number of retry attempts (0 = disabled) */
  maxRetries: number
  /** Initial delay in milliseconds before first retry */
  baseDelayMs: number
  /** Maximum delay between retries in milliseconds */
  maxDelayMs: number
}

/** Default predicate: transient connection drops and PG deadlocks. */
export function isRetryable(err: unknown): boolean {
  return err instanceof ConnectionError || err instanceof DeadlockError
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
  constructor(private readonly cfg: RetryConfig) {}

  run<T>(fn: () => Promise<T>, retryable?: (err: unknown) => boolean): Promise<T> {
    return withRetry(fn, this.cfg, retryable)
  }
}
