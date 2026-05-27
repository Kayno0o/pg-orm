import type { ExprBuilder, ExprTape } from '../../builder/expr'
import type { Executable } from '../../sql/executor'
import type { AnyColumns } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { DeleteBuilder } from '../../builder/query'

export async function deleteMany<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  where: (e: ExprBuilder<TC>) => ExprTape,
): Promise<any[]> {
  await runtime.runBefore('beforeDelete', undefined)

  const b = runtime.rewriteDelete<TC>(where)
    ?? new DeleteBuilder<TC>(runtime.table.name).where(where).returning()
  const { sql, params } = b.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterDelete', rows)

  return runtime.applyVirtuals(rows)
}

export async function deleteOne<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  where: (e: ExprBuilder<TC>) => ExprTape,
): Promise<any | null> {
  const rows = await deleteMany(executor, runtime, where)

  return rows[0] ?? null
}
