import type { AnyColumnDef, AnyTableDef } from '../../types/index'
import type { EnumUsage } from '../ddl'
import type { LiveEnum, LiveTable, MigrationOp } from '../types'
import { ValidationError } from '../../errors/index'
import { getColumnMeta } from '../../schema/column-meta'
import { buildAlterEnumAddSql, buildCreateEnumSql, buildEnumReplacementSqls, normalizeType } from '../ddl'
import { columnEntries } from '../types'

export function extractEnumInfo(colDef: AnyColumnDef): { name: string, values: string[] } | null {
  const { enumName, enumValues } = getColumnMeta(colDef)

  return enumName && enumValues ? { name: enumName, values: [...enumValues] } : null
}

/** The enum types the definitions use, an array of one included, with their values. */
export function collectEnumRequirements(desired: ReadonlyMap<string, AnyTableDef>): Map<string, string[]> {
  const neededEnums = new Map<string, string[]>()

  for (const tableDef of desired.values()) {
    for (const [, colDef] of columnEntries(tableDef.columns)) {
      const enumInfo = extractEnumInfo(colDef)

      if (!enumInfo)
        continue

      const seen = neededEnums.get(enumInfo.name)

      if (seen && seen.join('\0') !== enumInfo.values.join('\0'))
        throw new ValidationError(`Enum "${enumInfo.name}" is declared with different values: (${seen.join(', ')}) and (${enumInfo.values.join(', ')}) on "${tableDef.name}".`, 'enum', { field: enumInfo.name })

      neededEnums.set(enumInfo.name, enumInfo.values)
    }
  }

  return neededEnums
}

// The live columns typed with the enum, which its replacement must convert before the old type can go, with the default each gets back from its definition.
function liveUsages(enumName: string, liveTables: LiveTable[], desired: ReadonlyMap<string, AnyTableDef>): EnumUsage[] {
  const scalar = normalizeType(enumName)
  const usages: EnumUsage[] = []

  for (const table of liveTables) {
    for (const col of table.columns) {
      const type = normalizeType(col.dataType)

      if (type !== scalar && type !== `${scalar}[]`)
        continue

      const tableDef = desired.get(table.name)
      const entries = tableDef ? columnEntries(tableDef.columns) : []
      const colDef = (entries.find(([name]) => name === col.name) ?? entries.find(([, c]) => getColumnMeta(c).renamedFrom === col.name))?.[1]

      usages.push({
        table: table.name,
        column: col.name,
        array: type !== scalar,
        hasDefault: col.defaultValue !== null,
        restoreDefault: col.defaultValue === null ? undefined : colDef?.constraints.find(c => c.type === 'default')?.value,
      })
    }
  }

  return usages
}

export function diffEnums(
  neededEnums: Map<string, string[]>,
  liveEnums: LiveEnum[],
  liveTables: LiveTable[] = [],
  desired: ReadonlyMap<string, AnyTableDef> = new Map(),
): MigrationOp[] {
  const ops: MigrationOp[] = []
  const liveEnumMap = new Map(liveEnums.map(e => [e.name, e]))

  for (const [enumName, values] of neededEnums) {
    const liveEnum = liveEnumMap.get(enumName)

    if (!liveEnum) {
      ops.push({
        type: 'create_enum',
        sql: buildCreateEnumSql(enumName, values),
        destructive: false,
        description: `Create enum type "${enumName}"`,
      })

      continue
    }

    for (const val of values) {
      if (!liveEnum.values.includes(val)) {
        ops.push({
          type: 'alter_enum_add',
          sql: buildAlterEnumAddSql(enumName, val),
          destructive: false,
          description: `Add value '${val}' to enum "${enumName}"`,
        })
      }
    }

    // PG does not support ALTER TYPE ... DROP VALUE. Must: create new type,
    // alter all columns to use it, drop old type, rename new to old.
    const removedValues = liveEnum.values.filter(v => !values.includes(v))

    if (removedValues.length > 0) {
      const sqls = buildEnumReplacementSqls(enumName, values, liveUsages(enumName, liveTables, desired))

      for (const sql of sqls) {
        ops.push({
          type: 'alter_enum_remove',
          sql,
          destructive: true,
          description: `Replace enum "${enumName}" without values: ${removedValues.join(', ')}`,
        })
      }
    }
  }

  return ops
}
