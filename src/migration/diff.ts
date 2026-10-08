import type { AnyTableDef } from '../types/index'
import type { LiveCheck, LiveEnum, LiveForeignKey, LiveIndex, LiveTable, MigrationOp } from './types'
import { buildDropFkSql } from './ddl'
import { diffChecks } from './diff/checks'
import { collectEnumRequirements, diffEnums } from './diff/enums'
import { diffForeignKeys } from './diff/foreign-keys'
import { diffIndexes } from './diff/indexes'
import { diffTables } from './diff/tables'

/**
 * Compare live database schema against desired table definitions and return
 * migration operations. Detects table/column/enum/FK/index/CHECK changes. Destructive
 * operations are flagged with `destructive: true`.
 *
 * Ops come in an order Postgres accepts: types first, then the foreign keys and indexes going away while their tables and columns still exist, an enum losing values while only live columns use it, the tables and columns, and last what points at them.
 */
export function diffSchema(
  live: { tables: LiveTable[], enums: LiveEnum[], foreignKeys?: LiveForeignKey[], indexes?: LiveIndex[], checks?: LiveCheck[] },
  desired: ReadonlyMap<string, AnyTableDef>,
): MigrationOp[] {
  const droppedTables = new Set(live.tables.map(t => t.name).filter(n => !desired.has(n)))
  const enumOps = diffEnums(collectEnumRequirements(desired), live.enums, live.tables, desired)
  const fkOps = diffForeignKeys(desired, live.foreignKeys ?? [], live.tables)
  const indexOps = diffIndexes(desired, live.indexes ?? [], droppedTables)
  const isEnumRemoval = (op: MigrationOp) => op.type === 'alter_enum_remove'

  return [
    ...enumOps.filter(op => !isEnumRemoval(op)),
    ...fkOps.filter(op => op.type === 'drop_fk'),
    ...dropFksBetweenDroppedTables(live.foreignKeys ?? [], droppedTables),
    ...indexOps.filter(op => op.type === 'drop_index'),
    ...enumOps.filter(isEnumRemoval),
    ...diffTables(desired, live.tables),
    ...live.checks ? diffChecks(desired, live.tables, live.checks) : [],
    ...fkOps.filter(op => op.type !== 'drop_fk'),
    ...indexOps.filter(op => op.type !== 'drop_index'),
  ]
}

// A dropped table another dropped table points at cannot go first: the foreign key between them goes before either.
function dropFksBetweenDroppedTables(liveFks: LiveForeignKey[], droppedTables: Set<string>): MigrationOp[] {
  return liveFks
    .filter(fk => droppedTables.has(fk.tableName) && droppedTables.has(fk.referencedTable) && fk.tableName !== fk.referencedTable)
    .map(fk => ({
      type: 'drop_fk',
      table: fk.tableName,
      column: fk.columnName,
      sql: buildDropFkSql(fk.tableName, fk.constraintName),
      destructive: true,
      description: `Drop FK constraint "${fk.constraintName}" on "${fk.tableName}"."${fk.columnName}" (both tables dropped)`,
    }))
}
