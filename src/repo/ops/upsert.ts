import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferInsert, WriteReturnOptions } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { InsertBuilder } from '../../builder/query'

export async function upsertMany<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  values: InferInsert<TC>[],
  conflictTarget: (keyof TC & string)[],
  updateColumns?: (keyof TC & string)[],
  opts?: WriteReturnOptions,
): Promise<any[]> {
  if (values.length === 0)
    return []

  const v = await runtime.runBeforeMany('beforeUpsert', values)

  const retCols = opts?.full ? [] : [runtime.primaryKey]
  const ib = new InsertBuilder<TC>(runtime.table.name).many(v)
  const conflict = ib.onConflict(conflictTarget)
  const resolved = updateColumns?.length ? conflict.doUpdate(...updateColumns) : conflict.doUpdate()
  const final = resolved.returning(...retCols)
  const { sql, params } = final.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterInsert', rows)

  return opts?.full ? runtime.applyVirtuals(rows) : rows.map(r => r[runtime.primaryKey])
}
