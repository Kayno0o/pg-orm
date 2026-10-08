import type { AnyTableDef } from '../../types/index'
import type { LiveCheck, LiveEnum, LiveForeignKey, LiveIndex, LiveTable, MigrationOp } from '../types'
import { buildIndexName, buildRenameTableSql } from '../ddl'

export interface LiveSchema {
  tables: LiveTable[]
  enums: LiveEnum[]
  foreignKeys?: LiveForeignKey[]
  indexes?: LiveIndex[]
  checks?: LiveCheck[]
}

/**
 * Renames the tables whose definition says `renamedFrom()`: live under the old name, which no definition takes, and not yet under the new one.
 * Gives the ops, then the live schema as it reads once they ran, for the rest of the diff to compare against. An index named after its old table, as `withIndexes()` names one, is renamed with it.
 */
export function renameTables(live: LiveSchema, desired: ReadonlyMap<string, AnyTableDef>): { ops: MigrationOp[], live: LiveSchema } {
  const liveNames = new Set(live.tables.map(t => t.name))
  const renames = new Map<string, string>()

  for (const [name, tableDef] of desired) {
    const from = tableDef.previousName

    if (from !== undefined && !liveNames.has(name) && liveNames.has(from) && !desired.has(from))
      renames.set(from, name)
  }

  if (renames.size === 0)
    return { ops: [], live }

  const ops: MigrationOp[] = [...renames].map(([from, to]) => ({
    type: 'rename_table',
    table: to,
    sql: buildRenameTableSql(from, to),
    destructive: false,
    description: `Rename table "${from}" to "${to}"`,
    down: buildRenameTableSql(to, from),
  }))
  const renamed = (name: string) => renames.get(name) ?? name
  const indexes = (live.indexes ?? []).map((idx) => {
    const to = renames.get(idx.tableName)

    if (to === undefined || idx.name !== buildIndexName(idx.tableName, idx.columns, idx.isUnique))
      return { ...idx, tableName: renamed(idx.tableName) }

    const name = buildIndexName(to, idx.columns, idx.isUnique)

    ops.push({
      type: 'rename_index',
      table: to,
      sql: `ALTER INDEX "${idx.name}" RENAME TO "${name}"`,
      destructive: false,
      description: `Rename index "${idx.name}" to "${name}"`,
      down: `ALTER INDEX "${name}" RENAME TO "${idx.name}"`,
    })

    return { ...idx, name, tableName: to }
  })

  return {
    ops,
    live: {
      ...live,
      tables: live.tables.map(t => ({ ...t, name: renamed(t.name) })),
      foreignKeys: live.foreignKeys?.map(fk => ({ ...fk, tableName: renamed(fk.tableName), referencedTable: renamed(fk.referencedTable) })),
      indexes,
      checks: live.checks?.map(c => ({ ...c, tableName: renamed(c.tableName) })),
    },
  }
}
