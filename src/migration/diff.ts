import type { AnyTableDef } from '../types/index'
import type { LiveEnum, LiveForeignKey, LiveIndex, LiveTable, MigrationOp } from './types'
import { collectEnumInfo, diffEnums } from './diff/enums'
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
  const ops: MigrationOp[] = []
  const liveTableMap = new Map(live.tables.map(t => [t.name, t]))
  const liveEnumMap = new Map(live.enums.map(e => [e.name, e]))

  const neededEnums = new Map<string, string[]>()
  const enumUsages = new Map<string, { table: string, column: string }[]>()

  diffTables(ops, desired, liveTableMap, (tableName, tableDef) => {
    collectEnumInfo(tableDef, tableName, neededEnums, enumUsages)
  })

  diffEnums(ops, neededEnums, enumUsages, liveEnumMap)

  // Diff FK constraints — emits add_fk ops for both new and existing tables.
  // Runs unconditionally so new-table FKs are still added when callers omit `foreignKeys`.
  diffForeignKeys(ops, desired, live.foreignKeys ?? [])

  diffIndexes(ops, desired, live.indexes ?? [])

  return ops
}
