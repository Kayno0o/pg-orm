import type { HasDefault, NotNullable } from '../types/index'
import { ColumnBuilder, getColumnBuilderPgType } from './columns'
import { validateIdentifier, validateTypeArg } from './validate'

// Column type factory — the `t` parameter in defineTable(name, t => ...)
export interface ColumnTypes {
  // String types
  uuid: () => ColumnBuilder<string>
  text: <T extends string = string>() => ColumnBuilder<T>
  varchar: <T extends string = string>(n: number) => ColumnBuilder<T>
  char: <T extends string = string>(n: number) => ColumnBuilder<T>
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

// A type argument as written into the type, once checked: it lands in DDL as is.
function typeArg(value: number, context: string, min?: number): number {
  validateTypeArg(value, context, min)

  return value
}

/**
 * Per-type factory entries. Each builder is one line — adding a new pgType is
 * one new line here, no DSL changes. Variants (enum, array, numeric precision)
 * pass arguments into the pgType string.
 */
export function createColumnTypes(): ColumnTypes {
  return {
    uuid: () => new ColumnBuilder('uuid'),
    text: () => new ColumnBuilder('text'),
    varchar: n => new ColumnBuilder(`varchar(${typeArg(n, 'varchar length')})`),
    char: n => new ColumnBuilder(`char(${typeArg(n, 'char length')})`),
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
    numeric: (p, s) => new ColumnBuilder(p != null ? s != null ? `numeric(${typeArg(p, 'numeric precision')},${typeArg(s, 'numeric scale', 0)})` : `numeric(${typeArg(p, 'numeric precision')})` : 'numeric'),
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

    enum: <const TValues extends readonly string[]>(name: string, values: TValues) => {
      validateIdentifier(name, 'enum')

      const b = new ColumnBuilder<string>(name)

      // Store enum values for migration DDL (preserved through _build())
      b._enumName = name
      b._enumValues = values

      return b as unknown as ColumnBuilder<TValues[number]>
    },

    array: <T>(inner: ColumnBuilder<T>) => {
      const pgType = getColumnBuilderPgType(inner)
      const b = new ColumnBuilder<T[]>(`${pgType}[]`)

      // An enum array needs its type created as an enum column does.
      b._enumName = inner._enumName
      b._enumValues = inner._enumValues

      return b as unknown as ColumnBuilder<T[]>
    },

    vector: n => new ColumnBuilder(`vector(${typeArg(n, 'vector dimensions')})`),

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

    bit: n => new ColumnBuilder(n != null ? `bit(${typeArg(n, 'bit length')})` : 'bit'),
    varbit: n => new ColumnBuilder(n != null ? `varbit(${typeArg(n, 'varbit length')})` : 'varbit'),

    xml: () => new ColumnBuilder('xml'),
  }
}
