import type { ExprBuilder, ExprTape } from '../../builder/expr'
import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferUpdate } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { UpdateBuilder } from '../../builder/query'

export async function restore<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  where: (e: ExprBuilder<TC>) => ExprTape,
): Promise<any[]> {
  const sdCol = runtime.requireSoftDeleteColumn('restore()')

  const s = await runtime.runBefore('beforeUpdate', { [sdCol]: null } as InferUpdate<TC>)

  const b = new UpdateBuilder<TC>(runtime.table.name)
    .set(s)
    .where((e: ExprBuilder<TC>) => e.and(where(e), e.isNotNull(sdCol)))
    .returning()
  const { sql, params } = b.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterUpdate', rows)

  return rows
}
