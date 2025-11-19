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

export class StringFieldBuilder<Nullable extends boolean = false> {
  constructor(private config: StringFieldConfig<Nullable>) {}

  maxLength(length: number): StringFieldBuilder<Nullable> {
    return new StringFieldBuilder({ ...this.config, maxLength: length })
  }

  minLength(length: number): StringFieldBuilder<Nullable> {
    return new StringFieldBuilder({ ...this.config, minLength: length })
  }

  nullable(): StringFieldBuilder<true> {
    return new StringFieldBuilder({ ...this.config, nullable: true })
  }

  required(): StringFieldBuilder<false> {
    return new StringFieldBuilder({ ...this.config, nullable: false })
  }

  unique(): StringFieldBuilder<Nullable> {
    return new StringFieldBuilder({ ...this.config, unique: true })
  }

  default(value: string): StringFieldBuilder<Nullable> {
    return new StringFieldBuilder({ ...this.config, default: value })
  }

  column(name: string): StringFieldBuilder<Nullable> {
    return new StringFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): StringFieldConfig<Nullable> {
    return this.config
  }
}

// ============================================================================
// Number Field Builder
// ============================================================================

export class NumberFieldBuilder<Nullable extends boolean = false> {
  constructor(private config: NumberFieldConfig<Nullable>) {}

  min(value: number): NumberFieldBuilder<Nullable> {
    return new NumberFieldBuilder({ ...this.config, min: value })
  }

  max(value: number): NumberFieldBuilder<Nullable> {
    return new NumberFieldBuilder({ ...this.config, max: value })
  }

  integer(): NumberFieldBuilder<Nullable> {
    return new NumberFieldBuilder({ ...this.config, integer: true })
  }

  nullable(): NumberFieldBuilder<true> {
    return new NumberFieldBuilder({ ...this.config, nullable: true })
  }

  required(): NumberFieldBuilder<false> {
    return new NumberFieldBuilder({ ...this.config, nullable: false })
  }

  unique(): NumberFieldBuilder<Nullable> {
    return new NumberFieldBuilder({ ...this.config, unique: true })
  }

  default(value: number): NumberFieldBuilder<Nullable> {
    return new NumberFieldBuilder({ ...this.config, default: value })
  }

  column(name: string): NumberFieldBuilder<Nullable> {
    return new NumberFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): NumberFieldConfig<Nullable> {
    return this.config
  }
}

// ============================================================================
// Boolean Field Builder
// ============================================================================

export class BooleanFieldBuilder<Nullable extends boolean = false> {
  constructor(private config: BooleanFieldConfig<Nullable>) {}

  nullable(): BooleanFieldBuilder<true> {
    return new BooleanFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: boolean): BooleanFieldBuilder<Nullable> {
    return new BooleanFieldBuilder({ ...this.config, default: value })
  }

  column(name: string): BooleanFieldBuilder<Nullable> {
    return new BooleanFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): BooleanFieldConfig<Nullable> {
    return this.config
  }
}

// ============================================================================
// JSON Field Builder
// ============================================================================

export class JsonFieldBuilder<T = unknown, Nullable extends boolean = false> {
  constructor(private config: JsonFieldConfig<T, Nullable>) {}

  nullable(): JsonFieldBuilder<T, true> {
    return new JsonFieldBuilder({ ...this.config, nullable: true })
  }

  required(): JsonFieldBuilder<T, false> {
    return new JsonFieldBuilder({ ...this.config, nullable: false })
  }

  default(value: T): JsonFieldBuilder<T, Nullable> {
    return new JsonFieldBuilder({ ...this.config, default: value as SQLValue })
  }

  column(name: string): JsonFieldBuilder<T, Nullable> {
    return new JsonFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): JsonFieldConfig<T, Nullable> {
    return this.config
  }
}

// ============================================================================
// UUID Field Builder
// ============================================================================

export class UuidFieldBuilder<Nullable extends boolean = false> {
  constructor(private config: UuidFieldConfig<Nullable>) {}

  autoGenerate(): UuidFieldBuilder<Nullable> {
    return new UuidFieldBuilder({ ...this.config, autoGenerate: true })
  }

  nullable(): UuidFieldBuilder<true> {
    return new UuidFieldBuilder({ ...this.config, nullable: true })
  }

  unique(): UuidFieldBuilder<Nullable> {
    return new UuidFieldBuilder({ ...this.config, unique: true })
  }

  default(value: string): UuidFieldBuilder<Nullable> {
    return new UuidFieldBuilder({ ...this.config, default: value })
  }

  column(name: string): UuidFieldBuilder<Nullable> {
    return new UuidFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): UuidFieldConfig<Nullable> {
    return this.config
  }
}

// ============================================================================
// Timestamp Field Builder
// ============================================================================

export class TimestampFieldBuilder<Nullable extends boolean = false> {
  constructor(private config: TimestampFieldConfig<Nullable>) {}

  autoUpdate(): TimestampFieldBuilder<Nullable> {
    return new TimestampFieldBuilder({ ...this.config, autoUpdate: true })
  }

  nullable(): TimestampFieldBuilder<true> {
    return new TimestampFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: SQLValue): TimestampFieldBuilder<Nullable> {
    return new TimestampFieldBuilder({ ...this.config, default: value })
  }

  column(name: string): TimestampFieldBuilder<Nullable> {
    return new TimestampFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): TimestampFieldConfig<Nullable> {
    return this.config
  }
}

// ============================================================================
// Date Field Builder
// ============================================================================

export class DateFieldBuilder<Nullable extends boolean = false> {
  constructor(private config: DateFieldConfig<Nullable>) {}

  nullable(): DateFieldBuilder<true> {
    return new DateFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: SQLValue): DateFieldBuilder<Nullable> {
    return new DateFieldBuilder({ ...this.config, default: value })
  }

  column(name: string): DateFieldBuilder<Nullable> {
    return new DateFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): DateFieldConfig<Nullable> {
    return this.config
  }
}

// ============================================================================
// Array Field Builder
// ============================================================================

export class ArrayFieldBuilder<ArrayType extends 'string' | 'number' | 'boolean' = 'string' | 'number' | 'boolean', Nullable extends boolean = false> {
  constructor(private config: ArrayFieldConfig<ArrayType, Nullable>) {}

  nullable(): ArrayFieldBuilder<ArrayType, true> {
    return new ArrayFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: SQLValue): ArrayFieldBuilder<ArrayType, Nullable> {
    return new ArrayFieldBuilder({ ...this.config, default: value })
  }

  column(name: string): ArrayFieldBuilder<ArrayType, Nullable> {
    return new ArrayFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): ArrayFieldConfig<ArrayType, Nullable> {
    return this.config
  }
}

// ============================================================================
// Enum Field Builder
// ============================================================================

export class EnumFieldBuilder<Values extends readonly string[], Nullable extends boolean = false> {
  constructor(private config: EnumFieldConfig<Values, Nullable>) {}

  nullable(): EnumFieldBuilder<Values, true> {
    return new EnumFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: Values[number]): EnumFieldBuilder<Values, Nullable> {
    return new EnumFieldBuilder({ ...this.config, default: value })
  }

  column(name: string): EnumFieldBuilder<Values, Nullable> {
    return new EnumFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): EnumFieldConfig<Values, Nullable> {
    return this.config
  }
}

// ============================================================================
// Blob Field Builder
// ============================================================================

export class BlobFieldBuilder<Nullable extends boolean = false> {
  constructor(private config: BlobFieldConfig<Nullable>) {}

  nullable(): BlobFieldBuilder<true> {
    return new BlobFieldBuilder({ ...this.config, nullable: true })
  }

  column(name: string): BlobFieldBuilder<Nullable> {
    return new BlobFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): BlobFieldConfig<Nullable> {
    return this.config
  }
}

// ============================================================================
// Field Factory Functions
// ============================================================================

export const field = {
  string: () =>
    new StringFieldBuilder<false>({
      type: 'string',
      nullable: false,
      unique: false,
    }),

  number: () =>
    new NumberFieldBuilder<false>({
      type: 'number',
      nullable: false,
      unique: false,
    }),

  boolean: () =>
    new BooleanFieldBuilder<false>({
      type: 'boolean',
      nullable: false,
      unique: false,
    }),

  json: <T = unknown>() =>
    new JsonFieldBuilder<T, false>({
      type: 'json',
      nullable: false,
      unique: false,
      schema: undefined as T,
    }),

  jsonb: <T = unknown>() =>
    new JsonFieldBuilder<T, false>({
      type: 'jsonb',
      nullable: false,
      unique: false,
      schema: undefined as T,
    }),

  uuid: () =>
    new UuidFieldBuilder<false>({
      type: 'uuid',
      nullable: false,
      unique: false,
    }),

  timestamp: () =>
    new TimestampFieldBuilder<false>({
      type: 'timestamp',
      nullable: false,
      unique: false,
    }),

  date: () =>
    new DateFieldBuilder<false>({
      type: 'date',
      nullable: false,
      unique: false,
    }),

  array: <T extends 'string' | 'number' | 'boolean'>(arrayType: T) =>
    new ArrayFieldBuilder<T, false>({
      type: 'array',
      arrayType,
      nullable: false,
      unique: false,
    }),

  enum: <Values extends readonly string[]>(values: Values) =>
    new EnumFieldBuilder<Values, false>({
      type: 'enum',
      values,
      nullable: false,
      unique: false,
    }),

  blob: () =>
    new BlobFieldBuilder<false>({
      type: 'blob',
      nullable: false,
      unique: false,
    }),
}
