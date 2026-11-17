import type { AnyTableDef } from '../../types/index'
import type { LiveSchema, MigrationOp } from '../types'
import { getColumnMeta } from '../../schema/column-meta'
import { quote } from '../../sql/utils'
import { buildIndexName, buildRenameTableSql, uniqueName } from '../ddl'
import { columnEntries } from '../types'

/**
 * Gives the live indexes the names of the columns `renamedFrom()` renames, so the diff compares them with the definitions and finds nothing to rebuild: Postgres follows a renamed column in an index on its own.
 * An index named after its columns by default, as `.index()` and `withIndexes()` name one, is renamed with them when the definitions still declare it. An index over an expression keeps its text, which still names the old column, and is rebuilt.
 */
export function renameIndexedColumns(live: LiveSchema, desired: ReadonlyMap<string, AnyTableDef>): { ops: MigrationOp[], live: LiveSchema } {
  const renames = new Map<string, Map<string, string>>()
  const declared = new Set<string>()

  for (const [tableName, tableDef] of desired) {
    const liveColumns = new Set(live.tables.find(t => t.name === tableName)?.columns.map(c => c.name))
    const columns = columnEntries(tableDef.columns)
    const taken = new Set(columns.map(([name]) => name))
    const moved = new Map<string, string>()

    for (const [name, colDef] of columns) {
      const from = getColumnMeta(colDef).renamedFrom

      if (from !== undefined && liveColumns.has(from) && !liveColumns.has(name) && !taken.has(from))
        moved.set(from, name)
    }

    if (moved.size > 0)
      renames.set(tableName, moved)

    for (const idx of tableDef.indexes ?? [])
      declared.add(`${tableName}.${idx.name ?? buildIndexName(tableName, idx.columns, idx.unique ?? false)}`)
  }

  const ops: MigrationOp[] = []
  const indexes = live.indexes?.map((idx) => {
    const moved = renames.get(idx.tableName)

    if (!moved || !idx.columns.some(c => moved.has(c)))
      return idx

    const columns = idx.columns.map(c => moved.get(c) ?? c)
    const name = buildIndexName(idx.tableName, columns, idx.isUnique)

    if (idx.name !== buildIndexName(idx.tableName, idx.columns, idx.isUnique) || !declared.has(`${idx.tableName}.${name}`))
      return { ...idx, columns }

    ops.push({
      type: 'rename_index',
      table: idx.tableName,
      sql: `ALTER INDEX ${quote(idx.name)} RENAME TO ${quote(name)}`,
      destructive: false,
      description: `Rename index "${idx.name}" to "${name}"`,
      down: `ALTER INDEX ${quote(name)} RENAME TO ${quote(idx.name)}`,
    })

    return { ...idx, name, columns }
  })

  return { ops, live: { ...live, indexes } }
}

/**
 * Renames the tables whose definition says `renamedFrom()`: live under the old name, which no definition takes, and not yet under the new one.
 * Gives the ops, then the live schema as it reads once they ran, for the rest of the diff to compare against. An index or a composite UNIQUE named after its old table, as `withIndexes()` and `withUnique()` name one, is renamed with it.
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
      sql: `ALTER INDEX ${quote(idx.name)} RENAME TO ${quote(name)}`,
      destructive: false,
      description: `Rename index "${idx.name}" to "${name}"`,
      down: `ALTER INDEX ${quote(name)} RENAME TO ${quote(idx.name)}`,
    })

    return { ...idx, name, tableName: to }
  })
  const tables = live.tables.map((t) => {
    const to = renames.get(t.name)

    if (to === undefined)
      return t

    const uniques = t.uniques?.map((u) => {
      if (u.name !== uniqueName(t.name, { columns: u.columns }))
        return u

      const name = uniqueName(to, { columns: u.columns })

      ops.push({
        type: 'rename_constraint',
        table: to,
        sql: `ALTER TABLE ${quote(to)} RENAME CONSTRAINT ${quote(u.name)} TO ${quote(name)}`,
        destructive: false,
        description: `Rename UNIQUE constraint "${u.name}" to "${name}"`,
        down: `ALTER TABLE ${quote(to)} RENAME CONSTRAINT ${quote(name)} TO ${quote(u.name)}`,
      })

      return { ...u, name }
    })

    return { ...t, name: to, uniques }
  })

  return {
    ops,
    live: {
      ...live,
      tables,
      foreignKeys: live.foreignKeys?.map(fk => ({ ...fk, tableName: renamed(fk.tableName), referencedTable: renamed(fk.referencedTable) })),
      indexes,
      checks: live.checks?.map(c => ({ ...c, tableName: renamed(c.tableName) })),
    },
  }
}
