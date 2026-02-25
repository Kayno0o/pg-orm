import type {
  AnyColumnDef,
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

// Column builder — accumulates constraints, returns frozen ColumnDef on finalization
// Each method returns a new typed builder (cheap: just mutates internal arrays)
export class ColumnBuilder<
  TType = unknown,
  TNullable extends IsNullable | NotNullable = NotNullable,
  TDefault extends HasDefault | NoDefault = NoDefault,
  TPrimary extends IsPrimaryKey | NotPrimaryKey = NotPrimaryKey,
  TGenerated extends IsGenerated | NotGenerated = NotGenerated,
> {
  private _pgType: string
  private _constraints: ColumnConstraint[] = []
  private _references?: ForeignKeyRef
  _enumName?: string
  _enumValues?: readonly string[]
  _index?: { method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin', where?: string }
  _renamedFrom?: string

  constructor(pgType: string) {
    this._pgType = pgType
  }

  notNull(): ColumnBuilder<TType, NotNullable, TDefault, TPrimary, TGenerated> {
    this._constraints.push({ type: 'not_null' })

    return this as never
  }

  nullable(): ColumnBuilder<TType, IsNullable, TDefault, TPrimary, TGenerated> {
    // Remove any existing not_null constraint
    this._constraints = this._constraints.filter(c => c.type !== 'not_null')

    return this as never
  }

  default(value: string): ColumnBuilder<TType, TNullable, HasDefault, TPrimary, TGenerated> {
    this._constraints.push({ type: 'default', value })

    return this as never
  }

  primaryKey(): ColumnBuilder<TType, TNullable, HasDefault, IsPrimaryKey, TGenerated> {
    this._constraints.push({ type: 'primary_key' })

    // PK implies not null and has default (for type inference — PK is always optional on insert)
    return this as never
  }

  unique(): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._constraints.push({ type: 'unique' })

    return this as never
  }

  check(expr: string): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._constraints.push({ type: 'check', value: expr })

    return this as never
  }

  references(
    target: () => AnyColumnDef,
    opts?: { onDelete?: ForeignKeyRef['onDelete'], onUpdate?: ForeignKeyRef['onUpdate'] },
  ): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    // We store the reference info — resolved lazily during migration
    this._references = {
      table: target as unknown as ForeignKeyRef['table'],
      column: '', // resolved from the target column
      onDelete: opts?.onDelete,
      onUpdate: opts?.onUpdate,
    }
    this._constraints.push({ type: 'references' })

    return this as never
  }

  generated(expr: string): ColumnBuilder<TType, TNullable, HasDefault, TPrimary, IsGenerated> {
    this._constraints.push({ type: 'generated', value: expr })

    return this as never
  }

  /** Create a B-tree index on this column (or specify method/partial filter). */
  index(opts?: { method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin', where?: string }): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._index = { method: opts?.method, where: opts?.where }

    return this as never
  }

  /** Mark this column as renamed from a previous name to avoid DROP+ADD data loss. */
  renamedFrom(oldName: string): ColumnBuilder<TType, TNullable, TDefault, TPrimary, TGenerated> {
    this._renamedFrom = oldName

    return this as never
  }

  // Finalize — freeze and return ColumnDef. Called internally by defineTable.
  _build(): ColumnDef<TType, TNullable, TDefault, TPrimary, TGenerated> {
    const def: Record<string, unknown> = {
      _kind: 'column' as const,
      _type: undefined as unknown as TType,
      _nullable: undefined as unknown as TNullable,
      _default: undefined as unknown as TDefault,
      _primary: undefined as unknown as TPrimary,
      _generated: undefined as unknown as TGenerated,
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

    return Object.freeze(def) as unknown as ColumnDef<TType, TNullable, TDefault, TPrimary, TGenerated>
  }
}

// Column type factory — the `t` parameter in defineTable(name, t => ...)
export interface ColumnTypes {
  // String types
  uuid: () => ColumnBuilder<string>
  text: () => ColumnBuilder<string>
  varchar: (n: number) => ColumnBuilder<string>
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

  // Full-text search
  tsvector: () => ColumnBuilder<string>
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
    numeric: (p, s) => new ColumnBuilder(p != null ? (s != null ? `numeric(${p},${s})` : `numeric(${p})`) : 'numeric'),
    serial: () => new ColumnBuilder('serial') as never,
    bigserial: () => new ColumnBuilder('bigserial') as never,

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

    enum: (name, _values) => {
      const b = new ColumnBuilder(name)

      // Store enum values for migration DDL (preserved through _build())
      b._enumName = name
      b._enumValues = _values

      return b as never
    },

    array: (inner) => {
      const pgType = (inner as unknown as { _pgType: string })._pgType

      return new ColumnBuilder(`${pgType}[]`) as never
    },

    vector: n => new ColumnBuilder(`vector(${n})`),

    inet: () => new ColumnBuilder('inet'),
    tsvector: () => new ColumnBuilder('tsvector'),
  }
}
