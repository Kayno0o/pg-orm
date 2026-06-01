import type { ExprBuilder, ExprTape } from '../../builder/expr'
import type { Executable } from '../../sql/executor'
import type { AnyColumns, WriteReturnOptions } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { DeleteBuilder } from '../../builder/query'

export async function deleteMany<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  where: (e: ExprBuilder<TC>) => ExprTape,
  opts?: WriteReturnOptions,
): Promise<any[]> {
  await runtime.runBefore('beforeDelete', undefined)

  const retCols = opts?.full ? [] : [runtime.primaryKey]
  const rewritten = runtime.rewriteDelete<TC>(where)
  const b = rewritten
    ? rewritten.returning(...retCols)
    : new DeleteBuilder<TC>(runtime.table.name).where(where).returning(...retCols)
  const { sql, params } = b.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterDelete', rows)

  return opts?.full ? runtime.applyVirtuals(rows) : rows.map(r => r[runtime.primaryKey])
}

export async function deleteOne<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  where: (e: ExprBuilder<TC>) => ExprTape,
  opts?: WriteReturnOptions,
): Promise<any | null> {
  const rows = await deleteMany(executor, runtime, where, opts)

  return rows[0] ?? null
}
