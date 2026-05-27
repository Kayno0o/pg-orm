import type { ExprBuilder, ExprTape } from '../../builder/expr'
import type { Executable } from '../../sql/executor'
import type { AnyColumns } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { SelectBuilder } from '../../builder/query'

export async function count<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  where: ((e: ExprBuilder<TC>) => ExprTape) | undefined,
): Promise<number> {
  const builder = new SelectBuilder<TC>(runtime.table.name).count()

  if (where)
    builder.where(where)

  runtime.applyPreSelect(builder)

  const { sql, params } = builder.toSQL()
  const rows = await executor.query(sql, params)

  return Number(rows[0]?.count ?? 0)
}
