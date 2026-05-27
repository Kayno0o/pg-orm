import type { ExprBuilder, ExprTape } from '../../builder/expr'
import type { Executable } from '../../sql/executor'
import type { AnyColumns, InferUpdate } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import { StaleRecordError, ValidationError } from '../../errors/index'
import { updateMany } from './update-many'

export async function updateWithLock<TC extends AnyColumns>(
  executor: Executable,
  runtime: TableRuntime,
  set: InferUpdate<TC>,
  where: (e: ExprBuilder<TC>) => ExprTape,
  currentVersion: number,
): Promise<any> {
  const lockCol = runtime.optimisticLockColumn

  if (!lockCol) {
    throw new ValidationError(
      'updateWithLock requires optimisticLock trait on table',
      'updateWithLock',
      { field: runtime.table.name },
    )
  }

  const rows = await updateMany<TC>(executor, runtime, set, e =>
    e.and(where(e), e.eq(lockCol, currentVersion)))

  if (rows.length === 0)
    throw new StaleRecordError(runtime.table.name, currentVersion)

  return rows[0]
}
