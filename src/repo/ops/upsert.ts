import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferInsert } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { InsertBuilder } from '../../builder/query'

export async function upsertMany<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  values: InferInsert<TC>[],
  conflictTarget: (keyof TC & string)[],
  updateColumns?: (keyof TC & string)[],
): Promise<any[]> {
  if (values.length === 0)
    return []

  const v = await runtime.runBeforeMany('beforeUpsert', values)

  const ib = new InsertBuilder<TC>(runtime.table.name).many(v)
  const conflict = ib.onConflict(conflictTarget)
  const resolved = updateColumns?.length ? conflict.doUpdate(...updateColumns) : conflict.doUpdate()
  const final = resolved.returning()
  const { sql, params } = final.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterInsert', rows)

  runtime.applyVirtuals(rows)

  return rows
}
