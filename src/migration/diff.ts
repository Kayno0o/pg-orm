import type { AnyTableDef } from '../types/index'
import type { LiveEnum, LiveForeignKey, LiveIndex, LiveTable, MigrationOp } from './types'
import { collectEnumRequirements, diffEnums } from './diff/enums'
import { diffForeignKeys } from './diff/foreign-keys'
import { diffIndexes } from './diff/indexes'
import { diffTables } from './diff/tables'

/**
 * Compare live database schema against desired table definitions and return
 * migration operations. Detects table/column/enum/FK/index changes. Destructive
 * operations are flagged with `destructive: true`.
 */
export function diffSchema(
  live: { tables: LiveTable[], enums: LiveEnum[], foreignKeys?: LiveForeignKey[], indexes?: LiveIndex[] },
  desired: ReadonlyMap<string, AnyTableDef>,
): MigrationOp[] {
  const { neededEnums, enumUsages } = collectEnumRequirements(desired)
  const droppedTables = new Set(live.tables.map(t => t.name).filter(n => !desired.has(n)))

  return [
    ...diffEnums(neededEnums, enumUsages, live.enums),
    ...diffTables(desired, live.tables),
    ...diffForeignKeys(desired, live.foreignKeys ?? []),
    ...diffIndexes(desired, live.indexes ?? [], droppedTables),
  ]
}
