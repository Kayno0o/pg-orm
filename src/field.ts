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

export class StringFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: StringFieldConfig<Nullable, HasDefault>) {}

  maxLength(length: number): StringFieldBuilder<Nullable, HasDefault> {
    return new StringFieldBuilder({ ...this.config, maxLength: length })
  }

  minLength(length: number): StringFieldBuilder<Nullable, HasDefault> {
    return new StringFieldBuilder({ ...this.config, minLength: length })
  }

  nullable(): StringFieldBuilder<true, HasDefault> {
    return new StringFieldBuilder({ ...this.config, nullable: true })
  }

  required(): StringFieldBuilder<false, HasDefault> {
    return new StringFieldBuilder({ ...this.config, nullable: false })
  }

  unique(): StringFieldBuilder<Nullable, HasDefault> {
    return new StringFieldBuilder({ ...this.config, unique: true })
  }

  default(value: string): StringFieldBuilder<Nullable, true> {
    return new StringFieldBuilder({ ...this.config, default: value, hasDefault: true })
  }

  column(name: string): StringFieldBuilder<Nullable, HasDefault> {
    return new StringFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): StringFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

// ============================================================================
// Number Field Builder
// ============================================================================

export class NumberFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: NumberFieldConfig<Nullable, HasDefault>) {}

  min(value: number): NumberFieldBuilder<Nullable, HasDefault> {
    return new NumberFieldBuilder({ ...this.config, min: value })
  }

  max(value: number): NumberFieldBuilder<Nullable, HasDefault> {
    return new NumberFieldBuilder({ ...this.config, max: value })
  }

  integer(): NumberFieldBuilder<Nullable, HasDefault> {
    return new NumberFieldBuilder({ ...this.config, integer: true })
  }

  nullable(): NumberFieldBuilder<true, HasDefault> {
    return new NumberFieldBuilder({ ...this.config, nullable: true })
  }

  required(): NumberFieldBuilder<false, HasDefault> {
    return new NumberFieldBuilder({ ...this.config, nullable: false })
  }

  unique(): NumberFieldBuilder<Nullable, HasDefault> {
    return new NumberFieldBuilder({ ...this.config, unique: true })
  }

  default(value: number): NumberFieldBuilder<Nullable, true> {
    return new NumberFieldBuilder({ ...this.config, default: value, hasDefault: true })
  }

  column(name: string): NumberFieldBuilder<Nullable, HasDefault> {
    return new NumberFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): NumberFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

// ============================================================================
// Boolean Field Builder
// ============================================================================

export class BooleanFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: BooleanFieldConfig<Nullable, HasDefault>) {}

  nullable(): BooleanFieldBuilder<true, HasDefault> {
    return new BooleanFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: boolean): BooleanFieldBuilder<Nullable, true> {
    return new BooleanFieldBuilder({ ...this.config, default: value, hasDefault: true })
  }

  column(name: string): BooleanFieldBuilder<Nullable, HasDefault> {
    return new BooleanFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): BooleanFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

// ============================================================================
// JSON Field Builder
// ============================================================================

export class JsonFieldBuilder<T = unknown, Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: JsonFieldConfig<T, Nullable, HasDefault>) {}

  nullable(): JsonFieldBuilder<T, true, HasDefault> {
    return new JsonFieldBuilder({ ...this.config, nullable: true })
  }

  required(): JsonFieldBuilder<T, false, HasDefault> {
    return new JsonFieldBuilder({ ...this.config, nullable: false })
  }

  default(value: T): JsonFieldBuilder<T, Nullable, true> {
    return new JsonFieldBuilder({ ...this.config, default: value as SQLValue, hasDefault: true })
  }

  column(name: string): JsonFieldBuilder<T, Nullable, HasDefault> {
    return new JsonFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): JsonFieldConfig<T, Nullable, HasDefault> {
    return this.config
  }
}

// ============================================================================
// UUID Field Builder
// ============================================================================

export class UuidFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: UuidFieldConfig<Nullable, HasDefault>) {}

  autoGenerate(): UuidFieldBuilder<Nullable, HasDefault> {
    return new UuidFieldBuilder({ ...this.config, autoGenerate: true })
  }

  nullable(): UuidFieldBuilder<true, HasDefault> {
    return new UuidFieldBuilder({ ...this.config, nullable: true })
  }

  unique(): UuidFieldBuilder<Nullable, HasDefault> {
    return new UuidFieldBuilder({ ...this.config, unique: true })
  }

  default(value: string): UuidFieldBuilder<Nullable, true> {
    return new UuidFieldBuilder({ ...this.config, default: value, hasDefault: true })
  }

  column(name: string): UuidFieldBuilder<Nullable, HasDefault> {
    return new UuidFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): UuidFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

// ============================================================================
// Timestamp Field Builder
// ============================================================================

export class TimestampFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: TimestampFieldConfig<Nullable, HasDefault>) {}

  autoUpdate(): TimestampFieldBuilder<Nullable, HasDefault> {
    return new TimestampFieldBuilder({ ...this.config, autoUpdate: true })
  }

  nullable(): TimestampFieldBuilder<true, HasDefault> {
    return new TimestampFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: SQLValue): TimestampFieldBuilder<Nullable, true> {
    return new TimestampFieldBuilder({ ...this.config, default: value, hasDefault: true })
  }

  column(name: string): TimestampFieldBuilder<Nullable, HasDefault> {
    return new TimestampFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): TimestampFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

// ============================================================================
// Date Field Builder
// ============================================================================

export class DateFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: DateFieldConfig<Nullable, HasDefault>) {}

  nullable(): DateFieldBuilder<true, HasDefault> {
    return new DateFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: SQLValue): DateFieldBuilder<Nullable, true> {
    return new DateFieldBuilder({ ...this.config, default: value, hasDefault: true })
  }

  column(name: string): DateFieldBuilder<Nullable, HasDefault> {
    return new DateFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): DateFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

// ============================================================================
// Array Field Builder
// ============================================================================

export class ArrayFieldBuilder<ArrayType extends 'string' | 'number' | 'boolean' = 'string' | 'number' | 'boolean', Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: ArrayFieldConfig<ArrayType, Nullable, HasDefault>) {}

  nullable(): ArrayFieldBuilder<ArrayType, true, HasDefault> {
    return new ArrayFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: SQLValue): ArrayFieldBuilder<ArrayType, Nullable, true> {
    return new ArrayFieldBuilder({ ...this.config, default: value, hasDefault: true })
  }

  column(name: string): ArrayFieldBuilder<ArrayType, Nullable, HasDefault> {
    return new ArrayFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): ArrayFieldConfig<ArrayType, Nullable, HasDefault> {
    return this.config
  }
}

// ============================================================================
// Enum Field Builder
// ============================================================================

export class EnumFieldBuilder<Values extends readonly string[], Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: EnumFieldConfig<Values, Nullable, HasDefault>) {}

  nullable(): EnumFieldBuilder<Values, true, HasDefault> {
    return new EnumFieldBuilder({ ...this.config, nullable: true })
  }

  default(value: Values[number]): EnumFieldBuilder<Values, Nullable, true> {
    return new EnumFieldBuilder({ ...this.config, default: value, hasDefault: true })
  }

  column(name: string): EnumFieldBuilder<Values, Nullable, HasDefault> {
    return new EnumFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): EnumFieldConfig<Values, Nullable, HasDefault> {
    return this.config
  }
}

// ============================================================================
// Blob Field Builder
// ============================================================================

export class BlobFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: BlobFieldConfig<Nullable, HasDefault>) {}

  nullable(): BlobFieldBuilder<true, HasDefault> {
    return new BlobFieldBuilder({ ...this.config, nullable: true })
  }

  column(name: string): BlobFieldBuilder<Nullable, HasDefault> {
    return new BlobFieldBuilder({ ...this.config, columnName: name })
  }

  toConfig(): BlobFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

// ============================================================================
// Field Factory Functions
// ============================================================================

export const field = {
  string: () =>
    new StringFieldBuilder<false, false>({
      type: 'string',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  number: () =>
    new NumberFieldBuilder<false, false>({
      type: 'number',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  boolean: () =>
    new BooleanFieldBuilder<false, false>({
      type: 'boolean',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  json: <T = unknown>() =>
    new JsonFieldBuilder<T, false, false>({
      type: 'json',
      nullable: false,
      unique: false,
      hasDefault: false,
      schema: undefined as T,
    }),

  jsonb: <T = unknown>() =>
    new JsonFieldBuilder<T, false, false>({
      type: 'jsonb',
      nullable: false,
      unique: false,
      hasDefault: false,
      schema: undefined as T,
    }),

  uuid: () =>
    new UuidFieldBuilder<false, false>({
      type: 'uuid',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  timestamp: () =>
    new TimestampFieldBuilder<false, false>({
      type: 'timestamp',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  date: () =>
    new DateFieldBuilder<false, false>({
      type: 'date',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  array: <T extends 'string' | 'number' | 'boolean'>(arrayType: T) =>
    new ArrayFieldBuilder<T, false, false>({
      type: 'array',
      arrayType,
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  enum: <Values extends readonly string[]>(values: Values) =>
    new EnumFieldBuilder<Values, false, false>({
      type: 'enum',
      values,
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  blob: () =>
    new BlobFieldBuilder<false, false>({
      type: 'blob',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),
}
