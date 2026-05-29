import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferInsert } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { InsertBuilder } from '../../builder/query'

export async function insertMany<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  values: InferInsert<TC>[],
): Promise<any[]> {
  if (values.length === 0)
    return []

  const v = await runtime.runBeforeMany('beforeInsert', values)

  const b = new InsertBuilder<TC>(runtime.table.name).many(v).returning()
  const { sql, params } = b.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterInsert', rows)

  return runtime.applyVirtuals(rows)
}
