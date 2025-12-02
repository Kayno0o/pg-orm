import type {
  ArrayFieldConfig,
  BaseFieldConfig,
  BlobFieldConfig,
  BooleanFieldConfig,
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

  abstract toConfig(): Config
}

export class StringFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<StringFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: StringFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  maxLength(length: number): this {
    this.config.maxLength = length

    return this
  }

  minLength(length: number): this {
    this.config.minLength = length

    return this
  }

  nullable(): StringFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as StringFieldBuilder<true, HasDefault>
  }

  required(): StringFieldBuilder<false, HasDefault> {
    (this.config as StringFieldConfig<false, HasDefault>).nullable = false

    return this as StringFieldBuilder<false, HasDefault>
  }

  unique(): this {
    this.config.unique = true

    return this
  }

  default(value: string): StringFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as StringFieldBuilder<Nullable, true>
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  toConfig(): StringFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

export class NumberFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<NumberFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: NumberFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  min(value: number): this {
    this.config.min = value

    return this
  }

  max(value: number): this {
    this.config.max = value

    return this
  }

  integer(): this {
    this.config.integer = true

    return this
  }

  nullable(): NumberFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as NumberFieldBuilder<true, HasDefault>
  }

  required(): NumberFieldBuilder<false, HasDefault> {
    (this.config as NumberFieldConfig<false, HasDefault>).nullable = false

    return this as NumberFieldBuilder<false, HasDefault>
  }

  unique(): this {
    this.config.unique = true

    return this
  }

  default(value: number): NumberFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as NumberFieldBuilder<Nullable, true>
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  toConfig(): NumberFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

export class BooleanFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<BooleanFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: BooleanFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  nullable(): BooleanFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as BooleanFieldBuilder<true, HasDefault>
  }

  default(value: boolean): BooleanFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as BooleanFieldBuilder<Nullable, true>
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  toConfig(): BooleanFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

export class JsonFieldBuilder<T = unknown, Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<JsonFieldConfig<T, Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: JsonFieldConfig<T, Nullable, HasDefault>) {
    super(config)
  }

  nullable(): JsonFieldBuilder<T, true, HasDefault> {
    this.setNullable()

    return this as JsonFieldBuilder<T, true, HasDefault>
  }

  required(): JsonFieldBuilder<T, false, HasDefault> {
    (this.config as JsonFieldConfig<T, false, HasDefault>).nullable = false

    return this as JsonFieldBuilder<T, false, HasDefault>
  }

  default(value: T): JsonFieldBuilder<T, Nullable, true> {
    this.setDefault(value as SQLValue)

    return this as JsonFieldBuilder<T, Nullable, true>
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  toConfig(): JsonFieldConfig<T, Nullable, HasDefault> {
    return this.config
  }
}

export class UuidFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<UuidFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: UuidFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  autoGenerate(): this {
    this.config.autoGenerate = true

    return this
  }

  nullable(): UuidFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as UuidFieldBuilder<true, HasDefault>
  }

  unique(): this {
    this.config.unique = true

    return this
  }

  default(value: string): UuidFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as UuidFieldBuilder<Nullable, true>
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  toConfig(): UuidFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

export class TimestampFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<TimestampFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: TimestampFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  nullable(): TimestampFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as TimestampFieldBuilder<true, HasDefault>
  }

  default(value: SQLValue): TimestampFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as TimestampFieldBuilder<Nullable, true>
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  toConfig(): TimestampFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

export class DateFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<DateFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: DateFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  nullable(): DateFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as DateFieldBuilder<true, HasDefault>
  }

  default(value: SQLValue): DateFieldBuilder<Nullable, true> {
    this.setDefault(value)

    return this as DateFieldBuilder<Nullable, true>
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  toConfig(): DateFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

export class ArrayFieldBuilder<ArrayType extends 'string' | 'number' | 'boolean' = 'string' | 'number' | 'boolean', Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<ArrayFieldConfig<ArrayType, Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: ArrayFieldConfig<ArrayType, Nullable, HasDefault>) {
    super(config)
  }

  nullable(): ArrayFieldBuilder<ArrayType, true, HasDefault> {
    this.setNullable()

    return this as ArrayFieldBuilder<ArrayType, true, HasDefault>
  }

  default(value: SQLValue): ArrayFieldBuilder<ArrayType, Nullable, true> {
    this.setDefault(value)

    return this as ArrayFieldBuilder<ArrayType, Nullable, true>
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  toConfig(): ArrayFieldConfig<ArrayType, Nullable, HasDefault> {
    return this.config
  }
}

export class EnumFieldBuilder<Values extends readonly string[], Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<EnumFieldConfig<Values, Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: EnumFieldConfig<Values, Nullable, HasDefault>) {
    super(config)
  }

  nullable(): EnumFieldBuilder<Values, true, HasDefault> {
    this.setNullable()

    return this as EnumFieldBuilder<Values, true, HasDefault>
  }

  default(value: Values[number]): EnumFieldBuilder<Values, Nullable, true> {
    this.setDefault(value)

    return this as EnumFieldBuilder<Values, Nullable, true>
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  toConfig(): EnumFieldConfig<Values, Nullable, HasDefault> {
    return this.config
  }
}

export class BlobFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<BlobFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: BlobFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  nullable(): BlobFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as BlobFieldBuilder<true, HasDefault>
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  toConfig(): BlobFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

export class ForeignKeyFieldBuilder<Nullable extends boolean = false, HasDefault extends boolean = false> extends BaseFieldBuilder<ForeignKeyFieldConfig<Nullable, HasDefault>, Nullable, HasDefault> {
  constructor(config: ForeignKeyFieldConfig<Nullable, HasDefault>) {
    super(config)
  }

  nullable(): ForeignKeyFieldBuilder<true, HasDefault> {
    this.setNullable()

    return this as ForeignKeyFieldBuilder<true, HasDefault>
  }

  unique(): this {
    this.config.unique = true

    return this
  }

  column(name: string): this {
    this.setColumnName(name)

    return this
  }

  onDelete(action: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'): this {
    this.config.foreignKey.onDelete = action

    return this
  }

  onUpdate(action: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'): this {
    this.config.foreignKey.onUpdate = action

    return this
  }

  toConfig(): ForeignKeyFieldConfig<Nullable, HasDefault> {
    return this.config
  }
}

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
