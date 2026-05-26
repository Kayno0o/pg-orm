import type { AnyTableDef, HookEvent } from '../types/index'
import { AfterHookError, BeforeHookError } from '../errors/index'
import { hasHooks, runHooksAsync } from '../hooks/index'

/**
 * Centralized hook execution for repository CRUD methods. Keeps the single-row
 * and many-row code paths consistent so insertMany/upsertMany can't drift from
 * insertOne in how they invoke `beforeInsert` / `beforeUpsert`.
 *
 * All hook errors are wrapped — `BeforeHookError` (mutation aborted,
 * `committed: false`) for before-hooks and `AfterHookError` (mutation already
 * committed, `committed: true`) for after-hooks. Callers can branch on the
 * shared `committed` field without sniffing the inner error.
 */
export class HookOrchestrator {
  constructor(private table: AnyTableDef) {}

  async runBefore<T>(event: HookEvent, value: T): Promise<T> {
    if (!hasHooks(this.table, event))
      return value

    try {
      return await runHooksAsync(this.table, event, value)
    }
    catch (err) {
      throw new BeforeHookError(this.table.name, event, err)
    }
  }

  async runBeforeMany<T>(event: HookEvent, values: T[]): Promise<T[]> {
    if (!hasHooks(this.table, event))
      return values

    try {
      return await Promise.all(values.map(row => runHooksAsync(this.table, event, row)))
    }
    catch (err) {
      throw new BeforeHookError(this.table.name, event, err)
    }
  }

  async runAfter(event: HookEvent, rows?: unknown[]): Promise<void> {
    if (!hasHooks(this.table, event))
      return

    try {
      await runHooksAsync(this.table, event, rows)
    }
    catch (err) {
      throw new AfterHookError(this.table.name, event, err)
    }
  }
}
