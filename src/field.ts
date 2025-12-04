import type {
  ArrayFieldConfig,
  BaseFieldConfig,
  BlobFieldConfig,
  BooleanFieldConfig,
  CustomValidator,
  DateFieldConfig,
  EnumFieldConfig,
  ForeignKeyFieldConfig,
  JsonFieldConfig,
  NumberFieldConfig,
  SQLValue,
  StringFieldConfig,
  TimestampFieldConfig,
  UuidFieldConfig,
} from './types'
import { validateSQLIdentifier } from './sql-utils'

abstract class BaseFieldBuilder<
  Config extends BaseFieldConfig<Nullable, HasDefault>,
  Nullable extends boolean,
  HasDefault extends boolean,
> {
  constructor(protected config: Config) {}

  protected setNullable(): void {
    (this.config as any).nullable = true
  }

  protected setColumnName(name: string): void {
    validateSQLIdentifier(name, 'column')
    this.config.columnName = name
  }

  protected setDefault(value: SQLValue): void {
    (this.config as any).default = value;
    (this.config as any).hasDefault = true
  }

  protected addValidator<T>(validator: CustomValidator<T>, message: string): void {
    this.config.validators ||= [];
    (this.config.validators as any).push({ validator, message })
  }

  abstract toConfig(): Config
}

/** Builder for string fields. */
export class StringFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<StringFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: StringFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  /** Sets the maximum length of the string. */
  maxLength(length: number): this {
    this.config.maxLength = length

    return this
  }

  /** Sets the minimum length of the string. */
  minLength(length: number): this {
    this.config.minLength = length

    return this
  }

  /** Marks the field as nullable. */
  nullable(): StringFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as StringFieldBuilder<true, HasDefault>
  }

  /** Marks the field as required (not null). */
  required(): StringFieldBuilder<false, HasDefault> {
    (this.config as StringFieldConfig<false, HasDefault>).nullable = false

    return this as StringFieldBuilder<false, HasDefault>
  }

  /** Marks the field as unique. */
  unique(): this {
    this.config.unique = true

    return this
  }

  /** Sets the default value. */
  default(value: string): StringFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as StringFieldBuilder<Nullable, true>
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? string | null : string>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): StringFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

/** Builder for number fields. */
export class NumberFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<NumberFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: NumberFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  /** Sets the minimum value. */
  min(value: number): this {
    this.config.min = value

    return this
  }

  /** Sets the maximum value. */
  max(value: number): this {
    this.config.max = value

    return this
  }

  /** Ensures the number is an integer. */
  integer(): this {
    this.config.integer = true

    return this
  }

  /** Marks the field as nullable. */
  nullable(): NumberFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as NumberFieldBuilder<true, HasDefault>
  }

  /** Marks the field as required. */
  required(): NumberFieldBuilder<false, HasDefault> {
    (this.config as NumberFieldConfig<false, HasDefault>).nullable = false

    return this as NumberFieldBuilder<false, HasDefault>
  }

  /** Marks the field as unique. */
  unique(): this {
    this.config.unique = true

    return this
  }

  /** Sets the default value. */
  default(value: number): NumberFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as NumberFieldBuilder<Nullable, true>
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? number | null : number>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): NumberFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

/** Builder for boolean fields. */
export class BooleanFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<BooleanFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: BooleanFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  /** Marks the field as nullable. */
  nullable(): BooleanFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as BooleanFieldBuilder<true, HasDefault>
  }

  /** Sets the default value. */
  default(value: boolean): BooleanFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as BooleanFieldBuilder<Nullable, true>
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? boolean | null : boolean>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): BooleanFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

/** Builder for JSON fields. */
export class JsonFieldBuilder<T = unknown, Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<JsonFieldConfig<T, Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: JsonFieldConfig<T, Nullable, HasDefault>) {
    super(config)
  }

  /** Marks the field as nullable. */
  nullable(): JsonFieldBuilder<T, true, HasDefault> {
    this.setNullable()

    return this as JsonFieldBuilder<T, true, HasDefault>
  }

  /** Marks the field as required. */
  required(): JsonFieldBuilder<T, false, HasDefault> {
    (this.config as JsonFieldConfig<T, false, HasDefault>).nullable = false

    return this as JsonFieldBuilder<T, false, HasDefault>
  }

  /** Sets the default value. */
  default(value: T): JsonFieldBuilder<T, Nullable, true> {
    this.setDefault(value as SQLValue)

    return this as JsonFieldBuilder<T, Nullable, true>
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? T | null : T>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): JsonFieldConfig<T, Nullable, HasDefault> {
    return this.config
  }
}

/** Builder for UUID fields. */
export class UuidFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<UuidFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: UuidFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  /** Enables auto-generation for the UUID. */
  autoGenerate(): this {
    this.config.autoGenerate = true

    return this
  }

  /** Marks the field as nullable. */
  nullable(): UuidFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as UuidFieldBuilder<true, HasDefault>
  }

  /** Marks the field as unique. */
  unique(): this {
    this.config.unique = true

    return this
  }

  /** Sets the default value. */
  default(value: string): UuidFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as UuidFieldBuilder<Nullable, true>
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? string | null : string>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): UuidFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

/** Builder for timestamp fields. */
export class TimestampFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<TimestampFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: TimestampFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  /** Marks the field as nullable. */
  nullable(): TimestampFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as TimestampFieldBuilder<true, HasDefault>
  }

  /** Sets the default value. */
  default(value: SQLValue): TimestampFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as TimestampFieldBuilder<Nullable, true>
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? Date | null : Date>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): TimestampFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

/** Builder for date fields. */
export class DateFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<DateFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: DateFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  /** Marks the field as nullable. */
  nullable(): DateFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as DateFieldBuilder<true, HasDefault>
  }

  /** Sets the default value. */
  default(value: SQLValue): DateFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as DateFieldBuilder<Nullable, true>
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? Date | null : Date>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): DateFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

type InferArrayType<AT extends 'string' | 'number' | 'boolean'>
  = AT extends 'string' ? string[]
    : AT extends 'number' ? number[]
      : AT extends 'boolean' ? boolean[]
        : never

/** Builder for array fields. */
export class ArrayFieldBuilder<ArrayType extends 'string' | 'number' | 'boolean' = 'string' | 'number' | 'boolean', Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<ArrayFieldConfig<ArrayType, Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: ArrayFieldConfig<ArrayType, Nullable, HasDefault>) {
    super(config)
  }

  /** Marks the field as nullable. */
  nullable(): ArrayFieldBuilder<ArrayType, true, HasDefault> {
    this.setNullable()

    return this as ArrayFieldBuilder<ArrayType, true, HasDefault>
  }

  /** Sets the default value. */
  default(value: SQLValue): ArrayFieldBuilder<ArrayType, Nullable, true> {
    this.setDefault(value)

    return this as ArrayFieldBuilder<ArrayType, Nullable, true>
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? InferArrayType<ArrayType> | null : InferArrayType<ArrayType>>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): ArrayFieldConfig<ArrayType, Nullable, HasDefault> {
    return this.config
  }
}

/** Builder for enum fields. */
export class EnumFieldBuilder<Values extends readonly string[], Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<EnumFieldConfig<Values, Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: EnumFieldConfig<Values, Nullable, HasDefault>) {
    super(config)
  }

  /** Marks the field as nullable. */
  nullable(): EnumFieldBuilder<Values, true, HasDefault> {
    this.setNullable()

    return this as EnumFieldBuilder<Values, true, HasDefault>
  }

  /** Sets the default value. */
  default(value: Values[number]): EnumFieldBuilder<Values, Nullable, true> {
    this.setDefault(value)

    return this as EnumFieldBuilder<Values, Nullable, true>
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? Values[number] | null : Values[number]>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): EnumFieldConfig<Values, Nullable, HasDefault> {
    return this.config
  }
}

/** Builder for blob fields. */
export class BlobFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<BlobFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: BlobFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  /** Marks the field as nullable. */
  nullable(): BlobFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as BlobFieldBuilder<true, HasDefault>
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? Uint8Array | null : Uint8Array>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): BlobFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

/** Builder for foreign key fields. */
export class ForeignKeyFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<ForeignKeyFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: ForeignKeyFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  /** Marks the field as nullable. */
  nullable(): ForeignKeyFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as ForeignKeyFieldBuilder<true, HasDefault>
  }

  /** Marks the field as unique. */
  unique(): this {
    this.config.unique = true

    return this
  }

  /** Sets the database column name. */
  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  /** Sets the ON DELETE action. */
  onDelete(action: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'): this {
    this.config.foreignKey.onDelete = action

    return this
  }

  /** Sets the ON UPDATE action. */
  onUpdate(action: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'): this {
    this.config.foreignKey.onUpdate = action

    return this
  }

  /** Adds a custom validator. */
  refine(validator: CustomValidator<Nullable extends true ? number | null : number>, message: string): this {
    this.addValidator(validator, message)

    return this
  }

  toConfig(): ForeignKeyFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

/** Factory object for creating field builders. */
export const field = {
  /** Creates a string field builder. */
  string: () =>
    new StringFieldBuilder<false, false>({
      type: 'string',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  /** Creates a number field builder. */
  number: () =>
    new NumberFieldBuilder<false, false>({
      type: 'number',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  /** Creates a boolean field builder. */
  boolean: () =>
    new BooleanFieldBuilder<false, false>({
      type: 'boolean',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  /** Creates a JSON field builder. */
  json: <T = unknown>() =>
    new JsonFieldBuilder<T, false, false>({
      type: 'json',
      nullable: false,
      unique: false,
      hasDefault: false,
      schema: undefined as T,
    }),

  /** Creates a JSONB field builder. */
  jsonb: <T = unknown>() =>
    new JsonFieldBuilder<T, false, false>({
      type: 'jsonb',
      nullable: false,
      unique: false,
      hasDefault: false,
      schema: undefined as T,
    }),

  /** Creates a UUID field builder. */
  uuid: () =>
    new UuidFieldBuilder<false, false>({
      type: 'uuid',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  /** Creates a timestamp field builder. */
  timestamp: () =>
    new TimestampFieldBuilder<false, false>({
      type: 'timestamp',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  /** Creates a date field builder. */
  date: () =>
    new DateFieldBuilder<false, false>({
      type: 'date',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  /** Creates an array field builder. */
  array: <T extends 'string' | 'number' | 'boolean'>(arrayType: T) =>
    new ArrayFieldBuilder<T, false, false>({
      type: 'array',
      arrayType,
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  /** Creates an enum field builder. */
  enum: <Values extends readonly string[]>(values: Values) =>
    new EnumFieldBuilder<Values, false, false>({
      type: 'enum',
      values,
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  /** Creates a blob field builder. */
  blob: () =>
    new BlobFieldBuilder<false, false>({
      type: 'blob',
      nullable: false,
      unique: false,
      hasDefault: false,
    }),

  /** Creates a foreign key field builder. */
  foreignKey: (table: string, column = 'id') =>
    new ForeignKeyFieldBuilder<false, false>({
      type: 'foreignKey',
      nullable: false,
      unique: false,
      hasDefault: false,
      foreignKey: {
        table,
        column,
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
      },
    }),
}
