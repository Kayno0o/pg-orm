import type { ExprBuilder, ExprTape } from '../../builder/expr'
import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferUpdate, WriteReturnOptions } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { UpdateBuilder } from '../../builder/query'

export async function restore<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  where: (e: ExprBuilder<TC>) => ExprTape,
  opts?: WriteReturnOptions,
): Promise<any[]> {
  const sdCol = runtime.requireSoftDeleteColumn('restore()')

  const s = await runtime.runBefore('beforeUpdate', { [sdCol]: null } as InferUpdate<TC>)

  const retCols = opts?.full ? [] : [runtime.primaryKey]
  const b = new UpdateBuilder<TC>(runtime.table.name)
    .set(s)
    .where((e: ExprBuilder<TC>) => e.and(where(e), e.isNotNull(sdCol)))
    .returning(...retCols)
  const { sql, params } = b.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterUpdate', rows)

  return opts?.full ? runtime.applyVirtuals(rows) : rows.map(r => r[runtime.primaryKey])
}
