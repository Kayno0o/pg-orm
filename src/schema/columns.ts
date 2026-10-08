import type {
  AnyTableDef,
  ColumnConstraint,
  ColumnDef,
  ForeignKeyRef,
  HasDefault,
  IsGenerated,
  IsNullable,
  IsPrimaryKey,
  NoDefault,
  NotGenerated,
  NotNullable,
  NotPrimaryKey,
} from '../types/index'
import { phantom } from '../types/index'
import { toSQLDefault } from './column-default'
import { validateFkAction, validateIdentifier, validateIndexMethod } from './validate'

/** Read the `_index` metadata off a builder before `_build()` finalizes it. */
export function getColumnIndex(b: ColumnBuilder): { method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin', where?: string } | undefined {
  return b._index
}

/** Read the raw `pgType` string off a builder — used by `t.array(inner)`. */
export function getColumnBuilderPgType(b: ColumnBuilder): string {
  return b._pgType
}

// Column builder — accumulates constraints, returns frozen ColumnDef on finalization
// Each method returns a new typed builder (cheap: just mutates internal arrays)
export class ColumnBuilder<
  TType = unknown,
  TNullable extends IsNullable | NotNullable = NotNullable,
  TDefault extends HasDefault | NoDefault = NoDefault,
  TPrimary extends IsPrimaryKey | NotPrimaryKey = NotPrimaryKey,
  TGenerated extends IsGenerated | NotGenerated = NotGenerated,
> {
  readonly _pgType: string
  // NOT NULL unless `.nullable()` drops it, as the inferred type is.
  private _constraints: ColumnConstraint[] = [{ type: 'not_null' }]
  private _references?: ForeignKeyRef
  _enumName?: string
  _enumValues?: readonly string[]
  _index?: { method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin', where?: string }
  _renamedFrom?: string
  _min?: number
  _max?: number
  _minLength?: number
  _maxLength?: number
  _pattern?: string
  _oneOf?: readonly (string | number)[]
  _defaultLiteral?: { value: unknown }
  _backfill?: { value: unknown }

  constructor(pgType: string) {
    this._pgType = pgType
  }

  // Narrow `this` to a builder with different phantom generics. Runtime object is unchanged.
  private _narrow<T>(): T {
    return this as unknown as T
  }

  /** Mark column as NOT NULL, which it is unless `.nullable()` says otherwise. Required for insert unless it has a default. */
  notNull(): ColumnBuilder<TType, NotNullable, TDefault, TPrimary, TGenerated> {
    if (!this._constraints.some(c => c.type === 'not_null'))
      this._constraints.push({ type: 'not_null' })

    return this._narrow()
  }

  /** Mark column as nullable. The inferred type becomes `T | null`. */
  nullable(): ColumnBuilder<TType, IsNullable, TDefault, TPrimary, TGenerated> {
    // Remove any existing not_null constraint
    this._constraints = this._constraints.filter(c => c.type !== 'not_null')

    return this._narrow()
  }

  /** Set a DEFAULT value using a native JS value. Auto-converts to SQL. */
  default(value: TType): ColumnBuilder<TType, TNullable, HasDefault, TPrimary, TGenerated> {
    this._constraints.push({ type: 'default', value: toSQLDefault(value, this._pgType) })
    this._defaultLiteral = { value }

    return this._narrow()
  }

  /**
   * Set a DEFAULT using a raw SQL expression (e.g. `'now()'`, `'uuid_generate_v4()'`).
   *
   * @trusted The argument is embedded directly into DDL without parameterization.
   * Pass only developer-authored SQL — never user input. See README "Security model".
   */
  defaultRaw(sql: string): ColumnBuilder<TType, TNullable, HasDefault, TPrimary, TGenerated> {
    this._constraints.push({ type: 'default', value: sql })
    this._defaultLiteral = undefined

    return this._narrow()
  }

  /** Mark as primary key. Implies NOT NULL; required on insert unless the column has a default (`serial`, `.defaultRaw('gen_random_uuid()')`). */
  primaryKey(): ColumnBuilder<TType, TNullable, TDefault, IsPrimaryKey, TGenerated> {
    this._constraints.push({ type: 'primary_key' })

    return this._narrow()
  }

  /** Add a UNIQUE constraint on this column. */
  unique(): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._constraints.push({ type: 'unique' })

    return this._narrow()
  }

  /**
   * Add a CHECK constraint with a raw SQL expression.
   *
   * @trusted The expression is embedded directly into DDL without parameterization.
   * Pass only developer-authored SQL — never user input. See README "Security model".
   */
  check(expr: string): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._constraints.push({ type: 'check', value: expr })

    return this._narrow()
  }

  /** Add a minimum value CHECK constraint. The CHECK is generated using the column name at DDL time. */
  min(value: number): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._min = value

    return this._narrow()
  }

  /** Add a maximum value CHECK constraint. The CHECK is generated using the column name at DDL time. */
  max(value: number): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._max = value

    return this._narrow()
  }

  /** Add a minimum length CHECK constraint (for text/varchar). */
  minLength(value: number): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._minLength = value

    return this._narrow()
  }

  /** Add a maximum length CHECK constraint (for text/varchar). */
  maxLength(value: number): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._maxLength = value

    return this._narrow()
  }

  /** Add a regex pattern CHECK constraint (for text/varchar). Uses PostgreSQL `~` operator. */
  pattern(regex: string): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._pattern = regex

    return this._narrow()
  }

  /** Add a CHECK constraint restricting values to a set of allowed values. */
  oneOf<V extends TType>(values: readonly V[]): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._oneOf = values as readonly (string | number)[]

    return this._narrow()
  }

  /** Add a FOREIGN KEY reference to another table's column. The target is a thunk, or the table's name, which a self reference takes to stay typed. */
  references(
    target: (() => AnyTableDef) | string,
    column: string,
    opts?: { onDelete?: ForeignKeyRef['onDelete'], onUpdate?: ForeignKeyRef['onUpdate'] },
  ): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    if (typeof target === 'string')
      validateIdentifier(target, 'foreign key target table')

    validateIdentifier(column, 'referenced column')
    validateFkAction(opts?.onDelete, 'references() onDelete')
    validateFkAction(opts?.onUpdate, 'references() onUpdate')

    this._references = {
      table: typeof target === 'string' ? () => ({ name: target }) : target,
      column,
      onDelete: opts?.onDelete,
      onUpdate: opts?.onUpdate,
    }
    this._constraints.push({ type: 'references' })

    return this._narrow()
  }

  /**
   * Mark as a GENERATED ALWAYS AS (expr) STORED column.
   *
   * @trusted The expression is embedded directly into DDL without parameterization.
   * Pass only developer-authored SQL — never user input. See README "Security model".
   */
  generated(expr: string): ColumnBuilder<TType, TNullable, HasDefault, TPrimary, IsGenerated> {
    this._constraints.push({ type: 'generated', value: expr })

    return this._narrow()
  }

  /** Create a B-tree index on this column (or specify method/partial filter). */
  index(opts?: { method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin', where?: string }): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    validateIndexMethod(opts?.method, 'index()')
    this._index = { method: opts?.method, where: opts?.where }

    return this._narrow()
  }

  /** Mark this column as renamed from a previous name to avoid DROP+ADD data loss. */
  renamedFrom(oldName: string): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    validateIdentifier(oldName, 'renamedFrom column')
    this._renamedFrom = oldName

    return this._narrow()
  }

  /** The value the rows already in the table get when `sync()` adds this column NOT NULL and without a default. The column keeps no default. */
  backfill(value: TType): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._backfill = { value }

    return this._narrow()
  }

  // Finalize — freeze and return ColumnDef. Called internally by defineTable.
  _build(): ColumnDef<TType, TNullable, TDefault, TPrimary, TGenerated> {
    const def: Record<string, unknown> = {
      _kind: 'column' as const,
      _type: phantom<TType>(),
      _nullable: phantom<TNullable>(),
      _default: phantom<TDefault>(),
      _primary: phantom<TPrimary>(),
      _generated: phantom<TGenerated>(),
      pgType: this._pgType,
      constraints: Object.freeze(this._constraints) as ColumnConstraint[],
      references: this._references,
    }

    if (this._enumName) {
      def._enumName = this._enumName
      def._enumValues = this._enumValues
    }

    if (this._index)
      def._index = this._index

    if (this._renamedFrom)
      def._renamedFrom = this._renamedFrom

    if (this._min != null)
      def._min = this._min

    if (this._max != null)
      def._max = this._max

    if (this._minLength != null)
      def._minLength = this._minLength

    if (this._maxLength != null)
      def._maxLength = this._maxLength

    if (this._pattern != null)
      def._pattern = this._pattern

    if (this._oneOf != null)
      def._oneOf = this._oneOf

    if (this._defaultLiteral)
      def._defaultLiteral = this._defaultLiteral

    if (this._backfill)
      def._backfill = this._backfill

    return Object.freeze(def) as unknown as ColumnDef<TType, TNullable, TDefault, TPrimary, TGenerated>
  }
}
