import type { SelectBuilder } from '../builder/query'
import type { RowMapper } from '../mapper/index'
import type { Executable } from '../sql/executor'
import type { AnyTableDef } from '../types/index'
import type { HookOrchestrator } from './hooks'
import type { TraitDispatcher } from './middleware'
import type { RelationLoader } from './relation-loader'

/**
 * Frozen, per-repository shared context handed to each operation suite. Encapsulates
 * primitives that every suite needs without forcing each suite to re-derive them.
 *
 * Not exported from the package root — this is an internal contract between
 * `Repository` and its suite classes.
 */
export interface RepositoryCtx {
  readonly table: AnyTableDef
  readonly executor: Executable
  readonly tableRegistry?: ReadonlyMap<string, AnyTableDef>
  readonly maxIncludeDepth: number
  readonly batchChunkSize: number
  readonly defaultLimit?: number
  readonly relationLoader: RelationLoader
  readonly hooks: HookOrchestrator
  readonly traits: TraitDispatcher
  readonly getPrimaryKey: () => string
  readonly getMapper: (b: SelectBuilder<any, any, any>) => RowMapper<Record<string, unknown>>
  readonly query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>
}
