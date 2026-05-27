import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferInsert, InferPrimaryKey } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { InsertBuilder } from '../../builder/query'

export async function insertMany<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  values: InferInsert<TC>[],
): Promise<InferPrimaryKey<TC>[]> {
  if (values.length === 0)
    return []

  const v = await runtime.runBeforeMany('beforeInsert', values)

  const pk = runtime.primaryKey
  const b = new InsertBuilder<TC>(runtime.table.name).many(v).returning(pk)
  const { sql, params } = b.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterInsert', rows)

  return rows.map(r => r[pk]) as InferPrimaryKey<TC>[]
}
