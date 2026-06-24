import type { AnyColumnDef, AnyTableDef } from '../../types/index'
import type { LiveEnum, MigrationOp } from '../types'
import { getColumnMeta } from '../../schema/column-meta'
import { buildAlterEnumAddSql, buildCreateEnumSql, buildEnumReplacementSqls } from '../ddl'
import { columnEntries } from '../types'

export function extractEnumInfo(colDef: AnyColumnDef): { name: string, values: string[] } | null {
  const { enumName, enumValues } = getColumnMeta(colDef)

  if (enumName && enumValues) {
    return { name: enumName, values: [...enumValues] }
  }

  return null
}

export function collectEnumRequirements(
  desired: ReadonlyMap<string, AnyTableDef>,
): {
  neededEnums: Map<string, string[]>
  enumUsages: Map<string, { table: string, column: string }[]>
} {
  const neededEnums = new Map<string, string[]>()
  const enumUsages = new Map<string, { table: string, column: string }[]>()

  for (const [tableName, tableDef] of desired) {
    for (const [colName, colDef] of columnEntries(tableDef.columns)) {
      const enumInfo = extractEnumInfo(colDef)

      if (enumInfo) {
        neededEnums.set(enumInfo.name, enumInfo.values)

        if (!enumUsages.has(enumInfo.name))
          enumUsages.set(enumInfo.name, [])

        enumUsages.get(enumInfo.name)!.push({ table: tableName, column: colName })
      }
    }
  }

  return { neededEnums, enumUsages }
}

export function diffEnums(
  neededEnums: Map<string, string[]>,
  enumUsages: Map<string, { table: string, column: string }[]>,
  liveEnums: LiveEnum[],
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
      const usages = enumUsages.get(enumName) ?? []
      const sqls = buildEnumReplacementSqls(enumName, values, usages)

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
