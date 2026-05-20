import type { AnyTableDef, HookEvent } from '../types/index'
import { AfterHookError } from '../errors/index'
import { hasHooks, runHooksAsync } from '../hooks/index'

/**
 * Centralized hook execution for repository CRUD methods. Keeps the single-row
 * and many-row code paths consistent so insertMany/upsertMany can't drift from
 * insertOne in how they invoke `beforeInsert` / `beforeUpsert`.
 */
export class HookOrchestrator {
  constructor(private table: AnyTableDef) {}

  async runBefore<T>(event: HookEvent, value: T): Promise<T> {
    if (hasHooks(this.table, event)) {
      return runHooksAsync(this.table, event, value)
    }

    return value
  }

  async runBeforeMany<T>(event: HookEvent, values: T[]): Promise<T[]> {
    if (!hasHooks(this.table, event))
      return values

    return Promise.all(values.map(row => runHooksAsync(this.table, event, row)))
  }

  async runAfter(event: HookEvent, rows?: unknown[]): Promise<void> {
    if (hasHooks(this.table, event)) {
      try {
        await runHooksAsync(this.table, event, rows)
      }
      catch (err) {
        throw new AfterHookError(this.table.name, event, err)
      }
    }
  }
}
