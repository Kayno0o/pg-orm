import type { AnyColumnDef, AnyColumns, AnyTableDef, ColumnConstraint, Scope } from '../types/index'

const ARRAY_SUFFIX_RE = /(?:\[\])+$/
const TYPE_MODIFIER_RE = /\(.*\)$/
const EMPTY_COLUMNS: ReadonlySet<string> = new Set()
const NO_SCOPES: Readonly<Record<string, Scope>> = Object.freeze({})

/** Typed view of the metadata the built-in traits write onto `table.meta`. */
export interface TableMeta {
  softDelete?: { column: string }
  optimisticLock?: { column: string }
  timestamps?: { createdAt: string, updatedAt: string }
}

/** The built-in trait metadata on a table, typed — `table.meta` itself stays `Record<string, unknown>` so custom traits can put anything there. */
export function tableMeta(table: AnyTableDef): TableMeta {
  return table.meta as TableMeta
}

/** Whether a named trait has been applied to this table. Built-in names: `softDelete`, `optimisticLock`, `timestamps`. */
export function hasTrait(table: AnyTableDef, name: string): boolean {
  const applied = table.meta._appliedTraits as Set<string> | undefined

  return applied?.has(name) ?? false
}

/** The table's scopes by name, from its traits and `withScope`. */
export function tableScopes(table: AnyTableDef): Readonly<Record<string, Scope>> {
  return (table.meta._scopes as Record<string, Scope> | undefined) ?? NO_SCOPES
}

/** Every column any trait added to this table, custom traits included. */
export function traitColumns(table: AnyTableDef): ReadonlySet<string> {
  return (table.meta._traitColumns as Set<string> | undefined) ?? EMPTY_COLUMNS
}

/**
 * Columns a client may be allowed to write: everything except the primary key,
 * DB-generated columns, and trait-managed columns. Pass `exclude` for extra
 * app-managed columns.
 */
export function writableColumns(table: AnyTableDef, opts: { exclude?: Iterable<string> } = {}): string[] {
  const managed = new Set(traitColumns(table))

  for (const name of opts.exclude ?? [])
    managed.add(name)

  return Object.keys(table.columns).filter((name) => {
    if (name === table.primaryKey || managed.has(name))
      return false

    return !table.columns[name]!.constraints.some((c: ColumnConstraint) => c.type === 'primary_key' || c.type === 'generated')
  })
}

/** Whether `name` is one of the table's columns, narrowing a runtime string for `pick`, `orderBy` or `groupBy`: `if (isColumn(repo.table, sort)) q.orderBy(sort)`. */
export function isColumn<TColumns extends AnyColumns>(table: { readonly columns: TColumns }, name: string): name is keyof TColumns & string {
  return Object.hasOwn(table.columns, name)
}

/** Split a column's `pgType` into its bare type and array-ness: `varchar(255)` -> `varchar`, `int4[]` -> `int4` + `isArray`. */
export function columnBaseType(col: AnyColumnDef): { base: string, isArray: boolean } {
  const isArray = ARRAY_SUFFIX_RE.test(col.pgType)

  return {
    base: col.pgType.replace(ARRAY_SUFFIX_RE, '').replace(TYPE_MODIFIER_RE, ''),
    isArray,
  }
}
