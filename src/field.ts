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
import { validateSQLIdentifier } from './sql-utils'

// ============================================================================
// String Field Builder
// ============================================================================

/**
 * Builder for string field configuration
 * @template Nullable - Whether the field allows NULL values
 * @template HasDefault - Whether the field has a default value
 */
export class StringFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> {
  constructor(private config: StringFieldConfig<Nullable, HasDefault>) {}

  /**
   * Set maximum string length
   * @param length - Maximum number of characters
   * @example
   * ```ts
   * orm.string().maxLength(255)
   * ```
   */
  maxLength(length: number): StringFieldBuilder<Nullable, HasDefault> {
    this.config.maxLength = length

    return this
  }

  /**
   * Set minimum string length
   * @param length - Minimum number of characters
   * @example
   * ```ts
   * orm.string().minLength(3)
   * ```
   */
  minLength(length: number): StringFieldBuilder<Nullable, HasDefault> {
    this.config.minLength = length

    return this
  }

  /**
   * Make this field nullable (allows NULL values in database)
   * @returns Builder with nullable type set to true
   * @example
   * ```ts
   * orm.string().nullable() // Type: string | null
   * ```
   */
  nullable(): StringFieldBuilder<true, HasDefault> {
    (this.config as StringFieldConfig<true, HasDefault>).nullable = true

    return this as StringFieldBuilder<true, HasDefault>
  }

  /**
   * Make this field required (NOT NULL constraint)
   * @returns Builder with nullable type set to false
   * @example
   * ```ts
   * orm.string().required() // Type: string
   * ```
   */
  required(): StringFieldBuilder<false, HasDefault> {
    (this.config as StringFieldConfig<false, HasDefault>).nullable = false

    return this as StringFieldBuilder<false, HasDefault>
  }

  /**
   * Add UNIQUE constraint to this field
   * @example
   * ```ts
   * orm.string().unique()
   * ```
   */
  unique(): StringFieldBuilder<Nullable, HasDefault> {
    this.config.unique = true

    return this
  }

  /**
   * Set default value for this field
   * @param value - Default string value
   * @example
   * ```ts
   * orm.string().default('guest')
   * ```
   */
  default(value: string): StringFieldBuilder<Nullable, true> {
    (this.config as StringFieldConfig<Nullable, true>).default = value;
    (this.config as StringFieldConfig<Nullable, true>).hasDefault = true

    return this as StringFieldBuilder<Nullable, true>
  }

  /**
   * Override the database column name (default is snake_case of field name)
   * @param name - Custom column name
   * @example
   * ```ts
   * orm.string().column('full_name') // DB column: full_name
   * ```
   */
  column(name: string): StringFieldBuilder<Nullable, HasDefault> {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name

    return this
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
    this.config.min = value

    return this
  }

  max(value: number): NumberFieldBuilder<Nullable, HasDefault> {
    this.config.max = value

    return this
  }

  integer(): NumberFieldBuilder<Nullable, HasDefault> {
    this.config.integer = true

    return this
  }

  nullable(): NumberFieldBuilder<true, HasDefault> {
    (this.config as NumberFieldConfig<true, HasDefault>).nullable = true

    return this as NumberFieldBuilder<true, HasDefault>
  }

  required(): NumberFieldBuilder<false, HasDefault> {
    (this.config as NumberFieldConfig<false, HasDefault>).nullable = false

    return this as NumberFieldBuilder<false, HasDefault>
  }

  unique(): NumberFieldBuilder<Nullable, HasDefault> {
    this.config.unique = true

    return this
  }

  default(value: number): NumberFieldBuilder<Nullable, true> {
    (this.config as NumberFieldConfig<Nullable, true>).default = value;
    (this.config as NumberFieldConfig<Nullable, true>).hasDefault = true

    return this as NumberFieldBuilder<Nullable, true>
  }

  column(name: string): NumberFieldBuilder<Nullable, HasDefault> {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name

    return this
  }

  foreignKey(
    table: string,
    column = 'id',
    options?: {
      onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
      onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
    },
  ): NumberFieldBuilder<Nullable, HasDefault> {
    this.config.foreignKey = {
      table,
      column,
      onDelete: options?.onDelete || 'NO ACTION',
      onUpdate: options?.onUpdate || 'NO ACTION',
    }

    return this
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
    (this.config as BooleanFieldConfig<true, HasDefault>).nullable = true

    return this as BooleanFieldBuilder<true, HasDefault>
  }

  default(value: boolean): BooleanFieldBuilder<Nullable, true> {
    (this.config as BooleanFieldConfig<Nullable, true>).default = value;
    (this.config as BooleanFieldConfig<Nullable, true>).hasDefault = true

    return this as BooleanFieldBuilder<Nullable, true>
  }

  column(name: string): BooleanFieldBuilder<Nullable, HasDefault> {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name

    return this
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
    (this.config as JsonFieldConfig<T, true, HasDefault>).nullable = true

    return this as JsonFieldBuilder<T, true, HasDefault>
  }

  required(): JsonFieldBuilder<T, false, HasDefault> {
    (this.config as JsonFieldConfig<T, false, HasDefault>).nullable = false

    return this as JsonFieldBuilder<T, false, HasDefault>
  }

  default(value: T): JsonFieldBuilder<T, Nullable, true> {
    (this.config as JsonFieldConfig<T, Nullable, true>).default = value as SQLValue;
    (this.config as JsonFieldConfig<T, Nullable, true>).hasDefault = true

    return this as JsonFieldBuilder<T, Nullable, true>
  }

  column(name: string): JsonFieldBuilder<T, Nullable, HasDefault> {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name

    return this
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
    this.config.autoGenerate = true

    return this
  }

  nullable(): UuidFieldBuilder<true, HasDefault> {
    (this.config as UuidFieldConfig<true, HasDefault>).nullable = true

    return this as UuidFieldBuilder<true, HasDefault>
  }

  unique(): UuidFieldBuilder<Nullable, HasDefault> {
    this.config.unique = true

    return this
  }

  default(value: string): UuidFieldBuilder<Nullable, true> {
    (this.config as UuidFieldConfig<Nullable, true>).default = value;
    (this.config as UuidFieldConfig<Nullable, true>).hasDefault = true

    return this as UuidFieldBuilder<Nullable, true>
  }

  column(name: string): UuidFieldBuilder<Nullable, HasDefault> {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name

    return this
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
    this.config.autoUpdate = true

    return this
  }

  nullable(): TimestampFieldBuilder<true, HasDefault> {
    (this.config as TimestampFieldConfig<true, HasDefault>).nullable = true

    return this as TimestampFieldBuilder<true, HasDefault>
  }

  default(value: SQLValue): TimestampFieldBuilder<Nullable, true> {
    (this.config as TimestampFieldConfig<Nullable, true>).default = value;
    (this.config as TimestampFieldConfig<Nullable, true>).hasDefault = true

    return this as TimestampFieldBuilder<Nullable, true>
  }

  column(name: string): TimestampFieldBuilder<Nullable, HasDefault> {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name

    return this
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
    (this.config as DateFieldConfig<true, HasDefault>).nullable = true

    return this as DateFieldBuilder<true, HasDefault>
  }

  default(value: SQLValue): DateFieldBuilder<Nullable, true> {
    (this.config as DateFieldConfig<Nullable, true>).default = value;
    (this.config as DateFieldConfig<Nullable, true>).hasDefault = true

    return this as DateFieldBuilder<Nullable, true>
  }

  column(name: string): DateFieldBuilder<Nullable, HasDefault> {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name

    return this
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
    (this.config as ArrayFieldConfig<ArrayType, true, HasDefault>).nullable = true

    return this as ArrayFieldBuilder<ArrayType, true, HasDefault>
  }

  default(value: SQLValue): ArrayFieldBuilder<ArrayType, Nullable, true> {
    (this.config as ArrayFieldConfig<ArrayType, Nullable, true>).default = value;
    (this.config as ArrayFieldConfig<ArrayType, Nullable, true>).hasDefault = true

    return this as ArrayFieldBuilder<ArrayType, Nullable, true>
  }

  column(name: string): ArrayFieldBuilder<ArrayType, Nullable, HasDefault> {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name

    return this
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
    (this.config as EnumFieldConfig<Values, true, HasDefault>).nullable = true

    return this as EnumFieldBuilder<Values, true, HasDefault>
  }

  default(value: Values[number]): EnumFieldBuilder<Values, Nullable, true> {
    (this.config as EnumFieldConfig<Values, Nullable, true>).default = value;
    (this.config as EnumFieldConfig<Values, Nullable, true>).hasDefault = true

    return this as EnumFieldBuilder<Values, Nullable, true>
  }

  column(name: string): EnumFieldBuilder<Values, Nullable, HasDefault> {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name

    return this
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
    (this.config as BlobFieldConfig<true, HasDefault>).nullable = true

    return this as BlobFieldBuilder<true, HasDefault>
  }

  column(name: string): BlobFieldBuilder<Nullable, HasDefault> {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name

    return this
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
