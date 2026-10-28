import type { AnyTableDef, HookContext, HookEvent } from '../types/index'

// Hook execution pipeline — fires hooks synchronously, returns modified value

export function runHooks<T>(
  table: AnyTableDef,
  event: HookEvent,
  value: T,
  ctx?: HookContext,
): T {
  const hooks = table.hooks[event]

  if (!hooks || hooks.length === 0)
    return value

  let result = value

  for (const hook of hooks) {
    const hookResult = hook(result as never, ctx as never)

    if (hookResult !== undefined && hookResult !== null) {
      result = hookResult as T
    }
  }

  return result
}

// Async hook execution pipeline — awaits each hook in sequence, handing each the context as its second argument
export async function runHooksAsync<T>(
  table: AnyTableDef,
  event: HookEvent,
  value: T,
  ctx?: HookContext,
): Promise<T> {
  const hooks = table.hooks[event]

  if (!hooks || hooks.length === 0)
    return value

  let result = value

  for (const hook of hooks) {
    const hookResult = await hook(result as never, ctx as never)

    if (hookResult !== undefined && hookResult !== null) {
      result = hookResult as T
    }
  }

  return result
}

// Check if a table has hooks for a given event
export function hasHooks(table: AnyTableDef, event: HookEvent): boolean {
  const hooks = table.hooks[event]

  return hooks != null && hooks.length > 0
}
