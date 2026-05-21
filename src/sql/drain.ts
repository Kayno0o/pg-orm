/**
 * Tracks in-flight queries and coordinates graceful shutdown. Callers bracket
 * each query with `enter()` / `exit()`; `beginDrain()` flips the gate and
 * `waitForIdle()` resolves when the in-flight count reaches zero (or the
 * optional timeout fires).
 */
export class DrainCoordinator {
  private _draining = false
  private _inFlight = 0
  private _resolvers: (() => void)[] = []

  get draining(): boolean {
    return this._draining
  }

  /** Mark a query as started. Must be paired with `exit()`. */
  enter(): void {
    this._inFlight++
  }

  /** Mark a query as finished. Resolves any drain waiters when count hits 0. */
  exit(): void {
    this._inFlight--

    if (this._inFlight === 0 && this._resolvers.length > 0) {
      const resolvers = this._resolvers.splice(0)

      for (const resolve of resolvers) resolve()
    }
  }

  /** Flip the gate. Future callers can check `draining` and reject new work. */
  beginDrain(): void {
    this._draining = true
  }

  /**
   * Resolve when all in-flight queries finish, or when `timeoutMs` elapses
   * (whichever comes first). Returns immediately if already idle. The timeout
   * is `unref()`-ed so it never holds the event loop open.
   */
  async waitForIdle(timeoutMs?: number): Promise<void> {
    if (this._inFlight === 0)
      return

    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      const settle = (): void => {
        if (timer !== undefined)
          clearTimeout(timer)

        resolve()
      }

      this._resolvers.push(settle)

      if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          const idx = this._resolvers.indexOf(settle)

          if (idx >= 0)
            this._resolvers.splice(idx, 1)

          resolve()
        }, timeoutMs)

        timer.unref?.()
      }
    })
  }
}
