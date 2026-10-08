import type { Dialect } from '../dialect'
import type { AnyColumns } from '../types/index'
import { ValidationError } from '../errors/index'
import { quote } from '../sql/utils'
import { validateValues } from './state'

// A bound value needs a castable type name, and the serial pseudo-types are not one.
const SERIAL_CASTS: Record<string, string> = { serial: 'integer', bigserial: 'bigint', smallserial: 'smallint' }

export interface BulkUpdateRow {
  /** The row's primary key, one entry per key column. */
  key: Record<string, unknown>
  /** The columns this row writes. */
  set: Record<string, unknown>
}

/**
 * `UPDATE ... FROM (VALUES ...)`: one statement writing each row's own values, matched on the key columns.
 * A column only some rows set keeps its current value on the others, so rows may patch different columns.
 */
export class BulkUpdateBuilder {
  private _returning: string[] = []
  private _raw = new Map<string, string>()
  private _nullColumns: string[] = []

  constructor(
    private readonly table: string,
    private readonly columns: AnyColumns,
    private readonly keyColumns: string[],
    private readonly rows: BulkUpdateRow[],
  ) {}

  /**
   * Set a column to a raw SQL expression on every row. Internal, for ORM-managed writes like the optimistic-lock increment.
   *
   * @trusted The SQL expression is inlined verbatim.
   */
  setRaw(column: string, sqlExpression: string): this {
    this._raw.set(column, sqlExpression)

    return this
  }

  /** Only update rows where this column is null. */
  whereNull(column: string): this {
    this._nullColumns.push(column)

    return this
  }

  returning(...cols: string[]): this {
    this._returning = cols

    return this
  }

  // SQLite neither casts a bound value nor names the columns of a VALUES list, which it calls column1, column2...: a subquery renames them, and RETURNING takes no `table.*`.
  toSQL(dialect: Dialect = 'postgres'): { sql: string, params: unknown[] } {
    const sqlite = dialect === 'sqlite'
    const target = quote(this.table)
    const setColumns = this._setColumns()
    const params: unknown[] = []
    const cast = (column: string): string => sqlite ? '' : `::${this._castType(column)}`
    const bind = (value: unknown, column: string): string => {
      params.push(value)

      return `$${params.length}${cast(column)}`
    }

    const everywhere = setColumns.map(col => this.rows.every(row => col in row.set))
    const valueNames = [
      ...this.keyColumns.map((_, i) => `k${i}`),
      ...setColumns.flatMap((_, i) => everywhere[i] ? [`c${i}`] : [`c${i}`, `s${i}`]),
    ]

    const tuples = this.rows.map((row) => {
      const cells = this.keyColumns.map(col => bind(row.key[col], col))

      for (const [i, col] of setColumns.entries()) {
        const present = col in row.set

        cells.push(present ? bind(row.set[col], col) : `NULL${cast(col)}`)

        if (!everywhere[i])
          cells.push(present ? 'true' : 'false')
      }

      return `(${cells.join(', ')})`
    })

    const sets = setColumns.map((col, i) => everywhere[i]
      ? `${quote(col)} = "v"."c${i}"`
      : `${quote(col)} = CASE WHEN "v"."s${i}" THEN "v"."c${i}" ELSE ${target}.${quote(col)} END`)

    for (const [col, expr] of this._raw)
      sets.push(`${quote(col)} = ${expr}`)

    const match = [
      ...this.keyColumns.map((col, i) => `${target}.${quote(col)} = "v"."k${i}"`),
      ...this._nullColumns.map(col => `${target}.${quote(col)} IS NULL`),
    ].join(' AND ')
    const returning = this._returning.length
      ? this._returning.map(col => `${target}.${quote(col)}`).join(', ')
      : sqlite ? '*' : `${target}.*`
    const values = sqlite
      ? `(SELECT ${valueNames.map((name, i) => `"column${i + 1}" AS ${quote(name)}`).join(', ')} FROM (VALUES ${tuples.join(', ')})) AS "v"`
      : `(VALUES ${tuples.join(', ')}) AS "v" (${valueNames.map(quote).join(', ')})`

    return {
      sql: `UPDATE ${target} SET ${sets.join(', ')} FROM ${values} WHERE ${match} RETURNING ${returning}`,
      params,
    }
  }

  // Every column some row writes, in first-seen order, checked against the table; a raw-set column is left to its expression.
  private _setColumns(): string[] {
    const seen = new Set<string>()

    for (const row of this.rows) {
      validateValues(row.set, 'updateManyById()')

      for (const col of Object.keys(row.set)) {
        if (this._raw.has(col) || seen.has(col))
          continue

        if (!this.columns[col])
          throw new ValidationError(`updateManyById(): "${col}" is not a column of "${this.table}".`, 'updateManyById', { field: col })

        seen.add(col)
      }
    }

    if (seen.size === 0 && this._raw.size === 0)
      throw new ValidationError(`updateManyById(): no row sets any column on "${this.table}".`, 'updateManyById')

    return [...seen]
  }

  private _castType(column: string): string {
    const pgType = this.columns[column]!.pgType

    return SERIAL_CASTS[pgType] ?? pgType
  }
}
