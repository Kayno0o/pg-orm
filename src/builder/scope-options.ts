import type { ScopeOptions } from '../types/index'
import { SOFT_DELETE_SCOPE } from '../constants'
import { ValidationError } from '../errors/index'

/** The scopes a call lifts. Options often come from a parsed request, so a value of the wrong type throws rather than lifting a scope: `withoutScopes: 'tenant'` would match by substring, `withTrashed: 'false'` as true. */
export function liftedScopes(opts?: ScopeOptions): string[] {
  const lifted: unknown = opts?.withoutScopes ?? []

  if (!Array.isArray(lifted) || lifted.some(name => typeof name !== 'string'))
    throw new ValidationError('withoutScopes takes an array of scope names.', 'withoutScopes', { value: lifted })

  if (opts?.withTrashed !== undefined && typeof opts.withTrashed !== 'boolean')
    throw new ValidationError('withTrashed takes true or false.', 'withTrashed', { value: opts.withTrashed })

  return opts?.withTrashed ? [...lifted as string[], SOFT_DELETE_SCOPE] : lifted as string[]
}
