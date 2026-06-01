import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferInsert, WriteReturnOptions } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { InsertBuilder } from '../../builder/query'

export async function insertMany<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  values: InferInsert<TC>[],
  opts?: WriteReturnOptions,
): Promise<any[]> {
  if (values.length === 0)
    return []

  const v = await runtime.runBeforeMany('beforeInsert', values)

  const retCols = opts?.full ? [] : [runtime.primaryKey]
  const b = new InsertBuilder<TC>(runtime.table.name).many(v).returning(...retCols)
  const { sql, params } = b.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterInsert', rows)

  return opts?.full ? runtime.applyVirtuals(rows) : rows.map(r => r[runtime.primaryKey])
}
