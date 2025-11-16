import type {
  ArrayFieldConfig,
  BlobFieldConfig,
  BooleanFieldConfig,
  DateFieldConfig,
  EnumFieldConfig,
  FieldConfig,
  JsonFieldConfig,
  NumberFieldConfig,
  SQLValue,
  StringFieldConfig,
  TimestampFieldConfig,
  UuidFieldConfig,
} from './types'

// ============================================================================
// Base Field Builder
// ============================================================================

class BaseFieldBuilder<T extends FieldConfig> {
  constructor(protected config: T) {}

  nullable(): any {
    return new (this.constructor as any)({ ...this.config, nullable: true })
  }

  unique(): any {
    return new (this.constructor as any)({ ...this.config, unique: true })
  }

  default(value: SQLValue): any {
    return new (this.constructor as any)({ ...this.config, default: value })
  }

  column(name: string): any {
    return new (this.constructor as any)({ ...this.config, columnName: name })
  }

  toConfig(): T {
    return this.config
  }
}

// ============================================================================
// String Field Builder
// ============================================================================

class StringFieldBuilder extends BaseFieldBuilder<StringFieldConfig> {
  maxLength(length: number) {
    return new StringFieldBuilder({ ...this.config, maxLength: length })
  }

  minLength(length: number) {
    return new StringFieldBuilder({ ...this.config, minLength: length })
  }
}

// ============================================================================
// Number Field Builder
// ============================================================================

class NumberFieldBuilder extends BaseFieldBuilder<NumberFieldConfig> {
  min(value: number) {
    return new NumberFieldBuilder({ ...this.config, min: value })
  }

  max(value: number) {
    return new NumberFieldBuilder({ ...this.config, max: value })
  }

  integer() {
    return new NumberFieldBuilder({ ...this.config, integer: true })
  }
}

// ============================================================================
// Boolean Field Builder
// ============================================================================

class BooleanFieldBuilder extends BaseFieldBuilder<BooleanFieldConfig> {}

// ============================================================================
// JSON Field Builder
// ============================================================================

class JsonFieldBuilder<T = unknown> extends BaseFieldBuilder<JsonFieldConfig<T>> {}

// ============================================================================
// UUID Field Builder
// ============================================================================

class UuidFieldBuilder extends BaseFieldBuilder<UuidFieldConfig> {
  autoGenerate() {
    return new UuidFieldBuilder({ ...this.config, autoGenerate: true })
  }
}

// ============================================================================
// Timestamp Field Builder
// ============================================================================

class TimestampFieldBuilder extends BaseFieldBuilder<TimestampFieldConfig> {
  autoUpdate() {
    return new TimestampFieldBuilder({ ...this.config, autoUpdate: true })
  }
}

// ============================================================================
// Date Field Builder
// ============================================================================

class DateFieldBuilder extends BaseFieldBuilder<DateFieldConfig> {}

// ============================================================================
// Array Field Builder
// ============================================================================

class ArrayFieldBuilder extends BaseFieldBuilder<ArrayFieldConfig> {}

// ============================================================================
// Enum Field Builder
// ============================================================================

class EnumFieldBuilder<_T extends readonly string[]> extends BaseFieldBuilder<EnumFieldConfig> {}

// ============================================================================
// Blob Field Builder
// ============================================================================

class BlobFieldBuilder extends BaseFieldBuilder<BlobFieldConfig> {}

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
    }),

  jsonb: <T = unknown>() =>
    new JsonFieldBuilder<T>({
      type: 'jsonb',
      nullable: false,
      unique: false,
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

  array: (arrayType: 'string' | 'number' | 'boolean') =>
    new ArrayFieldBuilder({
      type: 'array',
      arrayType,
      nullable: false,
      unique: false,
    }),

  enum: <T extends readonly string[]>(values: T) =>
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

// Export builders for advanced usage
export {
  ArrayFieldBuilder,
  BaseFieldBuilder,
  BlobFieldBuilder,
  BooleanFieldBuilder,
  DateFieldBuilder,
  EnumFieldBuilder,
  JsonFieldBuilder,
  NumberFieldBuilder,
  StringFieldBuilder,
  TimestampFieldBuilder,
  UuidFieldBuilder,
}
