import type {
  ArrayFieldConfig,
  BlobFieldConfig,
  BooleanFieldConfig,
  DateFieldConfig,
  EnumFieldConfig,
  JsonFieldConfig,
  NumberFieldConfig,
  SQLValue,
  StringFieldConfig,
  TimestampFieldConfig,
  UuidFieldConfig,
} from './types'

// ============================================================================
// String Field Builder
// ============================================================================

export class StringFieldBuilder {
  constructor(private config: StringFieldConfig) {}

  maxLength(length: number) {
    return new StringFieldBuilder({ ...this.config, maxLength: length })
  }

  minLength(length: number) {
    return new StringFieldBuilder({ ...this.config, minLength: length })
  }

  nullable() {
    return new StringFieldBuilder({ ...this.config, nullable: true })
  }

  required() {
    return new StringFieldBuilder({ ...this.config, nullable: false })
  }

  unique() {
    return new StringFieldBuilder({ ...this.config, unique: true })
  }

  default(value: string) {
    return new StringFieldBuilder({ ...this.config, default: value })
  }

  column(name: string) {
    return new StringFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): StringFieldConfig {
    return this.config
  }
}

// ============================================================================
// Number Field Builder
// ============================================================================

export class NumberFieldBuilder {
  constructor(private config: NumberFieldConfig) {}

  min(value: number) {
    return new NumberFieldBuilder({ ...this.config, min: value })
  }

  max(value: number) {
    return new NumberFieldBuilder({ ...this.config, max: value })
  }

  integer() {
    return new NumberFieldBuilder({ ...this.config, integer: true })
  }

  nullable() {
    return new NumberFieldBuilder({ ...this.config, nullable: true })
  }

  required() {
    return new NumberFieldBuilder({ ...this.config, nullable: false })
  }

  unique() {
    return new NumberFieldBuilder({ ...this.config, unique: true })
  }

  default(value: number) {
    return new NumberFieldBuilder({ ...this.config, default: value })
  }

  column(name: string) {
    return new NumberFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): NumberFieldConfig {
    return this.config
  }
}

// ============================================================================
// Boolean Field Builder
// ============================================================================

export class BooleanFieldBuilder {
  constructor(private config: BooleanFieldConfig) {}

  nullable() {
    return new BooleanFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: boolean) {
    return new BooleanFieldBuilder({ ...this.config, default: value })
  }

  column(name: string) {
    return new BooleanFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): BooleanFieldConfig {
    return this.config
  }
}

// ============================================================================
// JSON Field Builder
// ============================================================================

export class JsonFieldBuilder<T = unknown> {
  constructor(private config: JsonFieldConfig<T>) {}

  nullable() {
    return new JsonFieldBuilder<T>({ ...this.config, nullable: true })
  }

  required() {
    return new JsonFieldBuilder<T>({ ...this.config, nullable: false })
  }

  default(value: T) {
    return new JsonFieldBuilder<T>({ ...this.config, default: value as SQLValue })
  }

  column(name: string) {
    return new JsonFieldBuilder<T>({ ...this.config, columnName: name })
  }

  toConfig(): JsonFieldConfig<T> {
    return this.config
  }
}

// ============================================================================
// UUID Field Builder
// ============================================================================

export class UuidFieldBuilder {
  constructor(private config: UuidFieldConfig) {}

  autoGenerate() {
    return new UuidFieldBuilder({ ...this.config, autoGenerate: true })
  }

  nullable() {
    return new UuidFieldBuilder({ ...this.config, nullable: true })
  }

  unique() {
    return new UuidFieldBuilder({ ...this.config, unique: true })
  }

  default(value: string) {
    return new UuidFieldBuilder({ ...this.config, default: value })
  }

  column(name: string) {
    return new UuidFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): UuidFieldConfig {
    return this.config
  }
}

// ============================================================================
// Timestamp Field Builder
// ============================================================================

export class TimestampFieldBuilder {
  constructor(private config: TimestampFieldConfig) {}

  autoUpdate() {
    return new TimestampFieldBuilder({ ...this.config, autoUpdate: true })
  }

  nullable() {
    return new TimestampFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: SQLValue) {
    return new TimestampFieldBuilder({ ...this.config, default: value })
  }

  column(name: string) {
    return new TimestampFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): TimestampFieldConfig {
    return this.config
  }
}

// ============================================================================
// Date Field Builder
// ============================================================================

export class DateFieldBuilder {
  constructor(private config: DateFieldConfig) {}

  nullable() {
    return new DateFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: SQLValue) {
    return new DateFieldBuilder({ ...this.config, default: value })
  }

  column(name: string) {
    return new DateFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): DateFieldConfig {
    return this.config
  }
}

// ============================================================================
// Array Field Builder
// ============================================================================

export class ArrayFieldBuilder<ArrayType extends 'string' | 'number' | 'boolean' = 'string' | 'number' | 'boolean'> {
  constructor(private config: ArrayFieldConfig<ArrayType>) {}

  nullable() {
    return new ArrayFieldBuilder<ArrayType>({ ...this.config, nullable: true })
  }

  default(value: SQLValue) {
    return new ArrayFieldBuilder<ArrayType>({ ...this.config, default: value })
  }

  column(name: string) {
    return new ArrayFieldBuilder<ArrayType>({ ...this.config, columnName: name })
  }

  toConfig(): ArrayFieldConfig<ArrayType> {
    return this.config
  }
}

// ============================================================================
// Enum Field Builder
// ============================================================================

export class EnumFieldBuilder<_T extends readonly string[]> {
  constructor(private config: EnumFieldConfig) {}

  nullable() {
    return new EnumFieldBuilder<_T>({ ...this.config, nullable: true })
  }

  default(value: _T[number]) {
    return new EnumFieldBuilder<_T>({ ...this.config, default: value })
  }

  column(name: string) {
    return new EnumFieldBuilder<_T>({ ...this.config, columnName: name })
  }

  toConfig(): EnumFieldConfig {
    return this.config
  }
}

// ============================================================================
// Blob Field Builder
// ============================================================================

export class BlobFieldBuilder {
  constructor(private config: BlobFieldConfig) {}

  nullable() {
    return new BlobFieldBuilder({ ...this.config, nullable: true })
  }

  column(name: string) {
    return new BlobFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): BlobFieldConfig {
    return this.config
  }
}

// ============================================================================
// Field Factory Functions
// ============================================================================

export const field = {
  string: () =>
    new StringFieldBuilder({
      type: 'string',
      nullable: false,
      unique: false,
    }),

  number: () =>
    new NumberFieldBuilder({
      type: 'number',
      nullable: false,
      unique: false,
    }),

  boolean: () =>
    new BooleanFieldBuilder({
      type: 'boolean',
      nullable: false,
      unique: false,
    }),

  json: <T = unknown>() =>
    new JsonFieldBuilder<T>({
      type: 'json',
      nullable: false,
      unique: false,
      schema: undefined as T,
    }),

  jsonb: <T = unknown>() =>
    new JsonFieldBuilder<T>({
      type: 'jsonb',
      nullable: false,
      unique: false,
      schema: undefined as T,
    }),

  uuid: () =>
    new UuidFieldBuilder({
      type: 'uuid',
      nullable: false,
      unique: false,
    }),

  timestamp: () =>
    new TimestampFieldBuilder({
      type: 'timestamp',
      nullable: false,
      unique: false,
    }),

  date: () =>
    new DateFieldBuilder({
      type: 'date',
      nullable: false,
      unique: false,
    }),

  array: <T extends 'string' | 'number' | 'boolean'>(arrayType: T) =>
    new ArrayFieldBuilder<T>({
      type: 'array',
      arrayType,
      nullable: false,
      unique: false,
    }),

  enum: <_T extends readonly string[]>(values: _T) =>
    new EnumFieldBuilder<_T>({
      type: 'enum',
      values,
      nullable: false,
      unique: false,
    }),

  blob: () =>
    new BlobFieldBuilder({
      type: 'blob',
      nullable: false,
      unique: false,
    }),
}
