import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferInsert, InferPrimaryKey } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { InsertBuilder } from '../../builder/query'

export async function insertOne<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  values: InferInsert<TC>,
): Promise<InferPrimaryKey<TC>> {
  const v = await runtime.runBefore('beforeInsert', values)

  const pk = runtime.primaryKey
  const b = new InsertBuilder<TC>(runtime.table.name).values(v).returning(pk)
  const { sql, params } = b.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterInsert', rows)

  return rows[0]![pk] as InferPrimaryKey<TC>
}
