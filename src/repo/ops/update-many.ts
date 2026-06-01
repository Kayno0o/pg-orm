import type { ExprBuilder, ExprTape } from '../../builder/expr'
import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferUpdate, WriteReturnOptions } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { UpdateBuilder } from '../../builder/query'

export async function updateMany<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  set: InferUpdate<TC>,
  where: (e: ExprBuilder<TC>) => ExprTape,
  opts?: WriteReturnOptions,
): Promise<any[]> {
  const s = await runtime.runBefore('beforeUpdate', set)

  const retCols = opts?.full ? [] : [runtime.primaryKey]
  const b = new UpdateBuilder<TC>(runtime.table.name)
    .set(s)
    .where(where)
    .returning(...retCols)

  // `applyPreUpdate` runs trait middleware (e.g. optimistic-lock version bump
  // via `setRaw()`) AFTER `.set()`'s `validateValues` check, so user payloads
  // can't smuggle `__raw` through and the version bump itself bypasses validation.
  runtime.applyPreUpdate(b)

  const { sql, params } = b.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterUpdate', rows)

  return opts?.full ? runtime.applyVirtuals(rows) : rows.map(r => r[runtime.primaryKey])
}

export async function updateOne<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  set: InferUpdate<TC>,
  where: (e: ExprBuilder<TC>) => ExprTape,
  opts?: WriteReturnOptions,
): Promise<any | null> {
  const rows = await updateMany(executor, runtime, set, where, opts)

  return rows[0] ?? null
}
