import type { AnyColumnDef, AnyTableDef } from '../../types/index'
import type { LiveEnum, MigrationOp } from '../types'
import { getColumnMeta } from '../../schema/column-meta'
import { escapeLiteralBody } from '../../sql/utils'
import { columnEntries } from '../types'

export function escapeEnumValue(val: string): string {
  return escapeLiteralBody(val)
}

export function extractEnumInfo(colDef: AnyColumnDef): { name: string, values: string[] } | null {
  const { enumName, enumValues } = getColumnMeta(colDef)

  if (enumName && enumValues) {
    return { name: enumName, values: [...enumValues] }
  }

  return null
}

export function collectEnumInfo(
  tableDef: AnyTableDef,
  tableName: string,
  neededEnums: Map<string, string[]>,
  enumUsages: Map<string, { table: string, column: string }[]>,
): void {
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

export function diffEnums(
  ops: MigrationOp[],
  neededEnums: Map<string, string[]>,
  enumUsages: Map<string, { table: string, column: string }[]>,
  liveEnumMap: Map<string, LiveEnum>,
): void {
  for (const [enumName, values] of neededEnums) {
    const liveEnum = liveEnumMap.get(enumName)

    if (!liveEnum) {
      ops.unshift({
        type: 'create_enum',
        sql: `CREATE TYPE "${enumName}" AS ENUM (${values.map(v => `'${escapeEnumValue(v)}'`).join(', ')})`,
        destructive: false,
        description: `Create enum type "${enumName}"`,
      })

      continue
    }

    for (const val of values) {
      if (!liveEnum.values.includes(val)) {
        ops.unshift({
          type: 'alter_enum_add',
          sql: `ALTER TYPE "${enumName}" ADD VALUE IF NOT EXISTS '${escapeEnumValue(val)}'`,
          destructive: false,
          description: `Add value '${val}' to enum "${enumName}"`,
        })
      }
    }

    // PG does not support ALTER TYPE ... DROP VALUE. Must: create new type,
    // alter all columns to use it, drop old type, rename new to old.
    const removedValues = liveEnum.values.filter(v => !values.includes(v))

    if (removedValues.length > 0)
      pushEnumRemovalOps(ops, enumName, values, removedValues, enumUsages)
  }
}

function pushEnumRemovalOps(
  ops: MigrationOp[],
  enumName: string,
  values: string[],
  removedValues: string[],
  enumUsages: Map<string, { table: string, column: string }[]>,
): void {
  const escapedValues = values.map(v => `'${escapeEnumValue(v)}'`).join(', ')
  const tmpName = `${enumName}_new`
  const usages = enumUsages.get(enumName) ?? []

  ops.push({
    type: 'alter_enum_remove',
    sql: `CREATE TYPE "${tmpName}" AS ENUM (${escapedValues})`,
    destructive: true,
    description: `Create replacement enum "${tmpName}" without values: ${removedValues.join(', ')}`,
  })

  for (const usage of usages) {
    ops.push({
      type: 'alter_enum_remove',
      sql: `ALTER TABLE "${usage.table}" ALTER COLUMN "${usage.column}" TYPE "${tmpName}" USING "${usage.column}"::text::"${tmpName}"`,
      destructive: true,
      description: `Migrate "${usage.table}"."${usage.column}" to replacement enum`,
    })
  }

  ops.push({
    type: 'alter_enum_remove',
    sql: `DROP TYPE "${enumName}"`,
    destructive: true,
    description: `Drop old enum type "${enumName}"`,
  })
  ops.push({
    type: 'alter_enum_remove',
    sql: `ALTER TYPE "${tmpName}" RENAME TO "${enumName}"`,
    destructive: true,
    description: `Rename "${tmpName}" to "${enumName}"`,
  })
}
