import type { SelectBuilder } from '../../builder/query'
import type { Executable } from '../../sql/executor'
import type { AnyColumns, AnyRelations } from '../../types/index'
import type { RelationResolver } from '../relation-resolver'
import type { TableRuntime } from '../table-runtime'
import type { MapperFactory } from './_mapper'
import { SelectBuilder as SelectBuilderCtor } from '../../builder/query'
import { hasHooks, runHooksAsync } from '../../hooks/index'
import { mapChunk } from '../../mapper/index'

export async function findMany<TC extends AnyColumns, TR extends AnyRelations>(
  executor: Executable,
  runtime: TableRuntime,
  relations: RelationResolver,
  mapper: MapperFactory,
  cb: ((q: SelectBuilder<TC, TR>) => SelectBuilder<TC, TR, any>) | undefined,
  defaultLimit: number | undefined,
): Promise<any[]> {
  const builder = new SelectBuilderCtor<TC, TR>(runtime.table.name)
  const finalBuilder = cb ? cb(builder) : builder

  runtime.applyPreSelect(finalBuilder)

  const state = finalBuilder.getState()

  if (defaultLimit != null && state.limit == null) {
    state.limit = defaultLimit
  }

  const { sql, params } = finalBuilder.toSQL()
  const rows = await executor.query(sql, params)

  // Skip JIT mapper for aggregate/computed-only queries (no table columns selected)
  const hasOnlyComputed = state.columns?.length === 0 && state.computedColumns.length > 0
  const mapperFn = hasOnlyComputed ? null : mapper(finalBuilder)
  let mapped = mapperFn ? mapChunk(mapperFn, rows) : rows

  if (hasHooks(runtime.table, 'afterSelect')) {
    mapped = await runHooksAsync(runtime.table, 'afterSelect', mapped)
  }

  mapped = runtime.applyVirtuals(mapped)

  if (state.includes.length > 0) {
    mapped = await relations.loadIncludes(mapped, state.includes)
  }

  return mapped
}
