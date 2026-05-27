import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferInsert } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { InsertBuilder } from '../../builder/query'

export async function findOrCreate<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  values: InferInsert<TC>,
  conflictTarget: (keyof TC & string)[],
): Promise<any> {
  const v = await runtime.runBefore('beforeUpsert', values)

  const pk = runtime.primaryKey
  const b = new InsertBuilder<TC>(runtime.table.name)
    .values(v)
    .onConflict(conflictTarget)
    .doUpdate(pk as keyof TC & string)
    .returning()
  const { sql, params } = b.toSQL()
  const rows = await executor.query(sql, params)

  await runtime.runAfter('afterInsert', rows)

  return runtime.applyVirtuals(rows)[0]
}
