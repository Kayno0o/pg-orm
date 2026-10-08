import type { AnyTableDef } from '../../types/index'
import type { MigrationOp } from '../types'
import type { SqliteLiveSchema, SqliteLiveTable } from './introspect'
import { getColumnMeta } from '../../schema/column-meta'
import { quote } from '../../sql/utils'
import { buildDropIndexSql, buildDropTableSql, buildRenameColumnSql } from '../ddl'
import { columnEntries } from '../types'
import { sqliteAddColumn, sqliteCreateIndex, sqliteCreateTable, sqliteIndexName, sqliteRebuildTable, sqliteType } from './ddl'

const SPACES_RE = /\s+/g
const PUNCTUATION_SPACE_RE = / ?([(),]) ?/g

// SQLite keeps DDL as written, so two spellings of one table differ only in whitespace: an `ADD COLUMN` lands as `, "c" TEXT` after the last column.
function normalize(sql: string): string {
  return sql.replace(SPACES_RE, ' ').replace(PUNCTUATION_SPACE_RE, '$1').trim()
}

// The DDL after the table name, which a rename of the table rewrites.
function body(sql: string): string {
  return normalize(sql.slice(sql.indexOf('(')))
}

function replaceIdentifier(sql: string, from: string, to: string): string {
  return sql.split(quote(from)).join(quote(to))
}

/**
 * The ops bringing an existing table to its definition. Renames and new columns are made in place when SQLite's ALTER TABLE can make them, and only when the table then reads exactly as the definition would create it.
 * Anything else, a dropped column, a changed type, constraint or default, is one `rebuild_table`.
 */
function diffTable(tableName: string, table: AnyTableDef, live: SqliteLiveTable): MigrationOp[] {
  const desiredSql = sqliteCreateTable(tableName, table)

  if (body(desiredSql) === body(live.sql))
    return []

  const liveTypes = new Map(live.columns.map(c => [c.name, c.type]))
  const sources = new Map<string, string>()
  const renames: [string, string][] = []

  for (const [name, colDef] of columnEntries(table.columns)) {
    const { renamedFrom } = getColumnMeta(colDef)

    if (liveTypes.has(name)) {
      sources.set(name, name)
    }
    else if (renamedFrom && liveTypes.has(renamedFrom) && !table.columns[renamedFrom]) {
      sources.set(name, renamedFrom)
      renames.push([renamedFrom, name])
    }
  }

  const kept = new Set(sources.values())
  const dropped = live.columns.map(c => c.name).filter(name => !kept.has(name))
  const names = Object.keys(table.columns)
  const added = names.filter(name => !sources.has(name))
  // ADD COLUMN appends, so a new column declared before an existing one only comes in its place through a rebuild.
  const appended = added.every(name => names.indexOf(name) >= names.length - added.length)
  const additions = added.map(name => sqliteAddColumn(tableName, table, name))
  const renamedSql = renames.reduce((sql, [from, to]) => replaceIdentifier(sql, from, to), live.sql)
  const inPlace = dropped.length === 0 && appended && additions.every(sql => sql !== undefined)
    && body(sqliteCreateTable(tableName, table, tableName, new Set(sources.keys()))) === body(renamedSql)

  if (inPlace) {
    return [
      ...renames.map(([from, to]): MigrationOp => ({
        type: 'rename_column',
        table: tableName,
        column: to,
        sql: buildRenameColumnSql(tableName, from, to),
        destructive: false,
        description: `Rename column "${from}" to "${to}" in "${tableName}"`,
      })),
      ...added.map((name, i): MigrationOp => ({
        type: 'add_column',
        table: tableName,
        column: name,
        sql: additions[i]!,
        destructive: false,
        description: `Add column "${name}" to "${tableName}"`,
      })),
    ]
  }

  const retyped = [...sources].filter(([name, source]) => liveTypes.get(source) !== sqliteType(tableName, name, table.columns[name]!.pgType))
  const changes = [
    ...renames.map(([from, to]) => `rename "${from}" to "${to}"`),
    ...added.map(name => `add "${name}"`),
    ...dropped.map(name => `drop "${name}"`),
    ...retyped.map(([name]) => `retype "${name}"`),
  ]

  return [{
    type: 'rebuild_table',
    table: tableName,
    sql: sqliteRebuildTable(tableName, table, sources).join(';\n'),
    destructive: dropped.length > 0 || retyped.length > 0,
    description: `Rebuild table "${tableName}"${changes.length > 0 ? ` (${changes.join(', ')})` : ' (constraints changed)'}`,
  }]
}

/** Compare a SQLite database against the table definitions, the way `diffSchema` does for Postgres. */
export function diffSqliteSchema(live: SqliteLiveSchema, desired: ReadonlyMap<string, AnyTableDef>): MigrationOp[] {
  const liveTables = new Map(live.tables.map(t => [t.name, t]))
  const tableOps: MigrationOp[] = []
  const indexOps: MigrationOp[] = []
  // A table created or rebuilt comes without indexes, every one of its own created anew.
  const fresh = new Set<string>()

  for (const [tableName, table] of desired) {
    const liveTable = liveTables.get(tableName)

    if (!liveTable) {
      fresh.add(tableName)
      tableOps.push({
        type: 'create_table',
        table: tableName,
        sql: sqliteCreateTable(tableName, table),
        destructive: false,
        description: `Create table "${tableName}"`,
      })

      continue
    }

    const ops = diffTable(tableName, table, liveTable)

    if (ops.some(op => op.type === 'rebuild_table'))
      fresh.add(tableName)

    tableOps.push(...ops)
  }

  for (const liveTable of live.tables) {
    if (desired.has(liveTable.name))
      continue

    tableOps.push({
      type: 'drop_table',
      table: liveTable.name,
      sql: buildDropTableSql(liveTable.name),
      destructive: true,
      description: `Drop table "${liveTable.name}"`,
    })
  }

  const liveIndexes = new Map(live.indexes.map(i => [i.name, i]))
  const wanted = new Set<string>()

  for (const [tableName, table] of desired) {
    for (const idx of table.indexes ?? []) {
      const name = sqliteIndexName(tableName, idx)
      const sql = sqliteCreateIndex(tableName, idx)
      const liveIdx = fresh.has(tableName) ? undefined : liveIndexes.get(name)

      wanted.add(name)

      if (liveIdx && normalize(liveIdx.sql) === normalize(sql))
        continue

      if (liveIdx) {
        indexOps.push({
          type: 'drop_index',
          table: tableName,
          sql: buildDropIndexSql(name),
          destructive: true,
          description: `Drop index "${name}" from "${tableName}" (changed)`,
        })
      }

      indexOps.push({
        type: 'create_index',
        table: tableName,
        sql,
        destructive: false,
        description: `${liveIdx ? 'Recreate' : 'Create'} index "${name}" on "${tableName}" (${idx.columns.join(', ')})`,
      })
    }
  }

  for (const liveIdx of live.indexes) {
    if (wanted.has(liveIdx.name) || !desired.has(liveIdx.table) || fresh.has(liveIdx.table))
      continue

    indexOps.push({
      type: 'drop_index',
      table: liveIdx.table,
      sql: buildDropIndexSql(liveIdx.name),
      destructive: true,
      description: `Drop index "${liveIdx.name}" from "${liveIdx.table}"`,
    })
  }

  return [...tableOps, ...indexOps]
}
