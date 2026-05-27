import type { ExprBuilder, ExprTape } from '../../builder/expr'
import type { Executable } from '../../sql/executor'
import type { AnyColumns } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { SelectBuilder } from '../../builder/query'

export async function exists<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  where: (e: ExprBuilder<TC>) => ExprTape,
): Promise<boolean> {
  const builder = new SelectBuilder<TC>(runtime.table.name)
    .where(where)
    .limit(1)

  runtime.applyPreSelect(builder)
  builder.asExists()

  const { sql, params } = builder.toSQL()
  const rows = await executor.query(sql, params)

  return rows.length > 0
}
