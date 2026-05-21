import type {
  AnyColumnDef,
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
import { escapeLiteralBody, quoteLiteral } from '../sql/utils'
import { phantom } from '../types/index'

/**
 * Underscore-prefixed metadata attached to a frozen `ColumnDef`. These fields
 * are preserved through `ColumnBuilder._build()` so that the migration diff
 * and DDL layer can read them, but they are intentionally not part of the
 * exposed `ColumnDef` type to keep that surface narrow. Read them via
 * `getColumnMeta()` rather than re-casting.
 */
export interface ColumnDefMeta {
  enumName?: string
  enumValues?: readonly string[]
  index?: { method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin', where?: string }
  renamedFrom?: string
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  oneOf?: readonly (string | number)[]
}

interface DefWithMeta {
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
}

export function getColumnMeta(def: AnyColumnDef): ColumnDefMeta {
  const d = def as AnyColumnDef & DefWithMeta

  return {
    enumName: d._enumName,
    enumValues: d._enumValues,
    index: d._index,
    renamedFrom: d._renamedFrom,
    min: d._min,
    max: d._max,
    minLength: d._minLength,
    maxLength: d._maxLength,
    pattern: d._pattern,
    oneOf: d._oneOf,
  }
}

/** Read the `_index` metadata off a builder before `_build()` finalizes it. */
export function getColumnIndex(b: ColumnBuilder): { method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin', where?: string } | undefined {
  return b._index
}

function getColumnBuilderPgType(b: ColumnBuilder): string {
  return b._pgType
}

/** Convert a JS value to a SQL DEFAULT expression based on the column's pgType. */
function toSQLDefault(value: unknown, pgType: string): string {
  if (value === null || value === undefined)
    return 'NULL'

  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value)

  if (typeof value === 'boolean')
    return value ? 'true' : 'false'

  if (value instanceof Date)
    return `'${value.toISOString()}'`

  if (Array.isArray(value)) {
    if (value.length === 0)
      return `ARRAY[]::${pgType}`

    const items = value.map(v =>
      typeof v === 'string' ? quoteLiteral(v) : String(v),
    ).join(',')

    return `ARRAY[${items}]::${pgType}`
  }

  if (typeof value === 'object')
    return `'${escapeLiteralBody(JSON.stringify(value))}'::${pgType}`

  if (typeof value === 'string')
    return quoteLiteral(value)

  return String(value)
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
  private _constraints: ColumnConstraint[] = []
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

  constructor(pgType: string) {
    this._pgType = pgType
  }

  // Narrow `this` to a builder with different phantom generics. Runtime object is unchanged.
  private _narrow<T>(): T {
    return this as unknown as T
  }

  /** Mark column as NOT NULL. Required for insert unless it has a default. */
  notNull(): ColumnBuilder<TType, NotNullable, TDefault, TPrimary, TGenerated> {
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

    return this._narrow()
  }

  /** Mark as primary key. Implies NOT NULL and optional on insert. */
  primaryKey(): ColumnBuilder<TType, TNullable, HasDefault, IsPrimaryKey, TGenerated> {
    this._constraints.push({ type: 'primary_key' })

    // PK implies not null and has default (for type inference — PK is always optional on insert)
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

  /** Add a FOREIGN KEY reference to another table's column. */
  references(
    target: () => AnyTableDef,
    column: string,
    opts?: { onDelete?: ForeignKeyRef['onDelete'], onUpdate?: ForeignKeyRef['onUpdate'] },
  ): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._references = {
      table: target,
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
    this._index = { method: opts?.method, where: opts?.where }

    return this._narrow()
  }

  /** Mark this column as renamed from a previous name to avoid DROP+ADD data loss. */
  renamedFrom(oldName: string): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._renamedFrom = oldName

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

    // Preserve enum metadata for migration diffing
    if (this._enumName) {
      def._enumName = this._enumName
      def._enumValues = this._enumValues
    }

    // Preserve index metadata for migration diffing
    if (this._index) {
      def._index = this._index
    }

    // Preserve rename metadata for migration diffing
    if (this._renamedFrom) {
      def._renamedFrom = this._renamedFrom
    }

    // Preserve min/max metadata for CHECK constraint generation
    if (this._min != null) {
      def._min = this._min
    }

    if (this._max != null) {
      def._max = this._max
    }

    if (this._minLength != null) {
      def._minLength = this._minLength
    }

    if (this._maxLength != null) {
      def._maxLength = this._maxLength
    }

    if (this._pattern != null) {
      def._pattern = this._pattern
    }

    if (this._oneOf != null) {
      def._oneOf = this._oneOf
    }

    return Object.freeze(def) as unknown as ColumnDef<TType, TNullable, TDefault, TPrimary, TGenerated>
  }
}

// Column type factory — the `t` parameter in defineTable(name, t => ...)
export interface ColumnTypes {
  // String types
  uuid: () => ColumnBuilder<string>
  text: <T extends string = string>() => ColumnBuilder<T>
  varchar: <T extends string = string>(n: number) => ColumnBuilder<T>
  citext: () => ColumnBuilder<string>

  // Numeric types
  int2: () => ColumnBuilder<number>
  int4: () => ColumnBuilder<number>
  int8: () => ColumnBuilder<bigint>
  smallint: () => ColumnBuilder<number>
  integer: () => ColumnBuilder<number>
  bigint: () => ColumnBuilder<bigint>
  float4: () => ColumnBuilder<number>
  float8: () => ColumnBuilder<number>
  real: () => ColumnBuilder<number>
  doublePrecision: () => ColumnBuilder<number>
  numeric: (precision?: number, scale?: number) => ColumnBuilder<string> // string to avoid float precision
  serial: () => ColumnBuilder<number, NotNullable, HasDefault>
  bigserial: () => ColumnBuilder<bigint, NotNullable, HasDefault>

  // Boolean
  bool: () => ColumnBuilder<boolean>
  boolean: () => ColumnBuilder<boolean>

  // Date/time
  date: () => ColumnBuilder<Date>
  timestamp: () => ColumnBuilder<Date>
  timestamptz: () => ColumnBuilder<Date>
  interval: () => ColumnBuilder<string>
  time: () => ColumnBuilder<string>
  timetz: () => ColumnBuilder<string>

  // JSON
  json: <T = unknown>() => ColumnBuilder<T>
  jsonb: <T = unknown>() => ColumnBuilder<T>

  // Binary
  bytea: () => ColumnBuilder<Uint8Array>

  // Enum
  enum: <const TValues extends readonly string[]>(
    name: string,
    values: TValues,
  ) => ColumnBuilder<TValues[number]>

  // Array
  array: <T>(inner: ColumnBuilder<T>) => ColumnBuilder<T[]>

  // Vector (pgvector)
  vector: (dimensions: number) => ColumnBuilder<number[]>

  // Network
  inet: () => ColumnBuilder<string>
  cidr: () => ColumnBuilder<string>
  macaddr: () => ColumnBuilder<string>

  // Full-text search
  tsvector: () => ColumnBuilder<string>
  tsquery: () => ColumnBuilder<string>

  // Geometric
  point: () => ColumnBuilder<string>
  line: () => ColumnBuilder<string>
  circle: () => ColumnBuilder<string>
  polygon: () => ColumnBuilder<string>
  box: () => ColumnBuilder<string>
  path: () => ColumnBuilder<string>

  // Monetary
  money: () => ColumnBuilder<string>

  // Bit strings
  bit: (n?: number) => ColumnBuilder<string>
  varbit: (n?: number) => ColumnBuilder<string>

  // XML
  xml: () => ColumnBuilder<string>
}

// Runtime implementation of column type factory
export function createColumnTypes(): ColumnTypes {
  return {
    uuid: () => new ColumnBuilder('uuid'),
    text: () => new ColumnBuilder('text'),
    varchar: n => new ColumnBuilder(`varchar(${n})`),
    citext: () => new ColumnBuilder('citext'),

    int2: () => new ColumnBuilder('int2'),
    int4: () => new ColumnBuilder('int4'),
    int8: () => new ColumnBuilder('int8'),
    smallint: () => new ColumnBuilder('int2'),
    integer: () => new ColumnBuilder('int4'),
    bigint: () => new ColumnBuilder('int8'),
    float4: () => new ColumnBuilder('float4'),
    float8: () => new ColumnBuilder('float8'),
    real: () => new ColumnBuilder('float4'),
    doublePrecision: () => new ColumnBuilder('float8'),
    numeric: (p, s) => new ColumnBuilder(p != null ? s != null ? `numeric(${p},${s})` : `numeric(${p})` : 'numeric'),
    serial: () => new ColumnBuilder<number>('serial') as unknown as ColumnBuilder<number, NotNullable, HasDefault>,
    bigserial: () => new ColumnBuilder<bigint>('bigserial') as unknown as ColumnBuilder<bigint, NotNullable, HasDefault>,

    bool: () => new ColumnBuilder('bool'),
    boolean: () => new ColumnBuilder('bool'),

    date: () => new ColumnBuilder('date'),
    timestamp: () => new ColumnBuilder('timestamp'),
    timestamptz: () => new ColumnBuilder('timestamptz'),
    interval: () => new ColumnBuilder('interval'),
    time: () => new ColumnBuilder('time'),
    timetz: () => new ColumnBuilder('timetz'),

    json: () => new ColumnBuilder('json'),
    jsonb: () => new ColumnBuilder('jsonb'),

    bytea: () => new ColumnBuilder('bytea'),

    enum: <const TValues extends readonly string[]>(name: string, _values: TValues) => {
      const b = new ColumnBuilder<string>(name)

      // Store enum values for migration DDL (preserved through _build())
      b._enumName = name
      b._enumValues = _values

      return b as unknown as ColumnBuilder<TValues[number]>
    },

    array: <T>(inner: ColumnBuilder<T>) => {
      const pgType = getColumnBuilderPgType(inner)

      return new ColumnBuilder<T[]>(`${pgType}[]`) as unknown as ColumnBuilder<T[]>
    },

    vector: n => new ColumnBuilder(`vector(${n})`),

    inet: () => new ColumnBuilder('inet'),
    cidr: () => new ColumnBuilder('cidr'),
    macaddr: () => new ColumnBuilder('macaddr'),

    tsvector: () => new ColumnBuilder('tsvector'),
    tsquery: () => new ColumnBuilder('tsquery'),

    point: () => new ColumnBuilder('point'),
    line: () => new ColumnBuilder('line'),
    circle: () => new ColumnBuilder('circle'),
    polygon: () => new ColumnBuilder('polygon'),
    box: () => new ColumnBuilder('box'),
    path: () => new ColumnBuilder('path'),

    money: () => new ColumnBuilder('money'),

    bit: n => new ColumnBuilder(n != null ? `bit(${n})` : 'bit'),
    varbit: n => new ColumnBuilder(n != null ? `varbit(${n})` : 'varbit'),

    xml: () => new ColumnBuilder('xml'),
  }
}
