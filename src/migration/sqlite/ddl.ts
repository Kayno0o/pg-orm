import type { AnyColumnDef, AnyTableDef, ColumnConstraint, IndexDef } from '../../types/index'
import { DialectError } from '../../errors/index'
import { isConstantSqliteDefault, sqliteDefaultSql } from '../../schema/column-default'
import { quote, quoteLiteral } from '../../sql/utils'
import { columnChecks } from '../checks'
import { buildIndexName } from '../ddl'
import { columnEntries } from '../types'

const INTEGER_TYPES = new Set(['int2', 'int4', 'int8', 'serial', 'bigserial', 'smallserial', 'bool'])
const SERIAL_TYPES = new Set(['serial', 'bigserial', 'smallserial'])
const REAL_TYPES = new Set(['float4', 'float8'])
// Types SQLite has nothing to store or compare them with.
const UNSUPPORTED_TYPE_RE = /^(?:vector|tsvector|tsquery)\b/

/** The prefix a table being rebuilt is created under, before it takes the name of the one it replaces. */
export const REBUILD_PREFIX = '_pgorm_new_'

function hasConstraint(colDef: AnyColumnDef, type: ColumnConstraint['type']): boolean {
  return colDef.constraints.some(c => c.type === type)
}

// The affinity a Postgres type is stored with: a boolean is 0 or 1, a date its ISO string, a JSON value or an array its JSON text.
export function sqliteType(tableName: string, colName: string, pgType: string): string {
  if (UNSUPPORTED_TYPE_RE.test(pgType))
    throw new DialectError(`The ${pgType} column "${tableName}"."${colName}"`, 'sqlite')

  if (INTEGER_TYPES.has(pgType))
    return 'INTEGER'

  if (REAL_TYPES.has(pgType))
    return 'REAL'

  if (pgType.startsWith('numeric') || pgType === 'money')
    return 'NUMERIC'

  return pgType === 'bytea' ? 'BLOB' : 'TEXT'
}

function primaryKeyOf(table: AnyTableDef): string[] {
  return columnEntries(table.columns).filter(([, colDef]) => hasConstraint(colDef, 'primary_key')).map(([name]) => name)
}

// A lone INTEGER primary key is SQLite's rowid, numbered on insert like a serial.
function rowidColumn(tableName: string, table: AnyTableDef): string | undefined {
  const pk = primaryKeyOf(table)
  const lone = pk.length === 1 && sqliteType(tableName, pk[0]!, table.columns[pk[0]!]!.pgType) === 'INTEGER' ? pk[0] : undefined
  const serials = columnEntries(table.columns).filter(([, colDef]) => SERIAL_TYPES.has(colDef.pgType)).map(([name]) => name)

  if (serials.some(name => name !== lone))
    throw new DialectError(`The serial column "${tableName}"."${serials.find(name => name !== lone)}" outside a single-column primary key`, 'sqlite')

  return lone
}

function columnSql(tableName: string, table: AnyTableDef, colName: string, colDef: AnyColumnDef): string {
  const parts = [quote(colName), sqliteType(tableName, colName, colDef.pgType)]
  const rowid = rowidColumn(tableName, table) === colName
  const isPk = hasConstraint(colDef, 'primary_key')
  const defaultSql = sqliteDefaultSql(colDef)
  const generated = colDef.constraints.find(c => c.type === 'generated')?.value
  const ref = colDef.references

  // AUTOINCREMENT keeps a deleted id from being handed out again, as a sequence would not.
  if (rowid)
    parts.push(SERIAL_TYPES.has(colDef.pgType) ? 'PRIMARY KEY AUTOINCREMENT' : 'PRIMARY KEY')

  // SQLite lets a primary key other than the rowid hold NULL unless told otherwise.
  if (hasConstraint(colDef, 'not_null') || (isPk && !rowid))
    parts.push('NOT NULL')

  if (defaultSql !== undefined)
    parts.push(`DEFAULT ${defaultSql}`)

  if (generated !== undefined)
    parts.push(`GENERATED ALWAYS AS (${generated}) STORED`)

  if (hasConstraint(colDef, 'unique') && !isPk)
    parts.push('UNIQUE')

  if (ref) {
    parts.push(`REFERENCES ${quote(ref.table().name)} (${quote(ref.column)})`)

    if (ref.onDelete)
      parts.push(`ON DELETE ${ref.onDelete.toUpperCase()}`)

    if (ref.onUpdate)
      parts.push(`ON UPDATE ${ref.onUpdate.toUpperCase()}`)
  }

  for (const check of columnChecks(tableName, colName, colDef, 'sqlite'))
    parts.push(`CONSTRAINT ${quote(check.name)} CHECK (${check.expr})`)

  return parts.join(' ')
}

/** `CREATE TABLE` for `tableName`, created as `sqlName` when that differs, as a rebuild does. Only the definition's own columns are written when `only` lists them. */
export function sqliteCreateTable(tableName: string, table: AnyTableDef, sqlName = tableName, only?: ReadonlySet<string>): string {
  const lines = columnEntries(table.columns)
    .filter(([name]) => !only || only.has(name))
    .map(([name, colDef]) => `  ${columnSql(tableName, table, name, colDef)}`)
  const pk = primaryKeyOf(table)

  if (pk.length > 0 && rowidColumn(tableName, table) === undefined)
    lines.push(`  PRIMARY KEY (${pk.map(quote).join(', ')})`)

  return `CREATE TABLE ${quote(sqlName)} (\n${lines.join(',\n')}\n)`
}

/** `ALTER TABLE ... ADD COLUMN`, or undefined for a column SQLite only adds by rebuilding its table. */
export function sqliteAddColumn(tableName: string, table: AnyTableDef, colName: string): string | undefined {
  const colDef = table.columns[colName]!
  const defaultSql = sqliteDefaultSql(colDef)
  const notNull = hasConstraint(colDef, 'not_null')
  const addable = !hasConstraint(colDef, 'primary_key')
    && !hasConstraint(colDef, 'unique')
    && !hasConstraint(colDef, 'generated')
    && (defaultSql === undefined || isConstantSqliteDefault(defaultSql))
    && !(notNull && (defaultSql === undefined || defaultSql.toUpperCase() === 'NULL'))
    && !(colDef.references && defaultSql !== undefined && defaultSql.toUpperCase() !== 'NULL')

  return addable ? `ALTER TABLE ${quote(tableName)} ADD COLUMN ${columnSql(tableName, table, colName, colDef)}` : undefined
}

/**
 * Rebuilds a table to its definition the way SQLite documents it: a new table is created, the rows the two share are copied over, the old one dropped and the new one renamed.
 * `sources` maps each column to the live one it is copied from. The caller runs it with foreign keys off, which keeps the drop from cascading.
 * An AUTOINCREMENT table keeps its counter, which the drop would take with it, so an id deleted before the rebuild is not handed out again.
 */
export function sqliteRebuildTable(tableName: string, table: AnyTableDef, sources: ReadonlyMap<string, string>): string[] {
  const tmp = `${REBUILD_PREFIX}${tableName}`
  const copied = [...sources].filter(([name]) => !hasConstraint(table.columns[name]!, 'generated'))
  const sqls = [sqliteCreateTable(tableName, table, tmp)]

  if (copied.length > 0) {
    const into = copied.map(([name]) => quote(name)).join(', ')
    const from = copied.map(([, source]) => quote(source)).join(', ')

    sqls.push(`INSERT INTO ${quote(tmp)} (${into}) SELECT ${from} FROM ${quote(tableName)}`)
  }

  const rowid = rowidColumn(tableName, table)

  if (rowid !== undefined && SERIAL_TYPES.has(table.columns[rowid]!.pgType)) {
    sqls.push(
      `DELETE FROM sqlite_sequence WHERE name = ${quoteLiteral(tmp)}`,
      `INSERT INTO sqlite_sequence (name, seq) SELECT ${quoteLiteral(tmp)}, seq FROM sqlite_sequence WHERE name = ${quoteLiteral(tableName)}`,
    )
  }

  sqls.push(`DROP TABLE ${quote(tableName)}`, `ALTER TABLE ${quote(tmp)} RENAME TO ${quote(tableName)}`)

  return sqls
}

export function sqliteIndexName(tableName: string, idx: IndexDef): string {
  return idx.name ?? buildIndexName(tableName, idx.columns, idx.unique ?? false)
}

/** `CREATE INDEX`, the definition's method left out: SQLite has B-trees only. */
export function sqliteCreateIndex(tableName: string, idx: IndexDef): string {
  const where = idx.where ? ` WHERE ${idx.where}` : ''

  return `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${quote(sqliteIndexName(tableName, idx))} ON ${quote(tableName)} (${idx.columns.map(quote).join(', ')})${where}`
}
