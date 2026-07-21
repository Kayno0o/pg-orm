import type { Trait } from '../traits'

// Branded type for SQL identifiers
declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type SQLIdentifier = Brand<string, 'SQLIdentifier'>

/**
 * Phantom value: typed as `T` but always `undefined` at runtime. Used for
 * type-only fields on definition objects (e.g. `_type`, `_nullable`) that
 * exist only to drive TypeScript inference. Centralizes a previously-inline
 * `undefined as unknown as T` pattern.
 */
export function phantom<T>(): T {
  return undefined as T
}

// Column nullability / default tracking at the type level
export interface HasDefault { readonly hasDefault: true }
export interface NoDefault { readonly hasDefault: false }
export interface IsNullable { readonly nullable: true }
export interface NotNullable { readonly nullable: false }
export interface IsPrimaryKey { readonly primaryKey: true }
export interface NotPrimaryKey { readonly primaryKey: false }
export interface IsGenerated { readonly generated: true }
export interface NotGenerated { readonly generated: false }

// Column definition — carries full type metadata as phantom types
export interface ColumnDef<
  TType = unknown,
  TNullable extends IsNullable | NotNullable = NotNullable,
  TDefault extends HasDefault | NoDefault = NoDefault,
  TPrimary extends IsPrimaryKey | NotPrimaryKey = NotPrimaryKey,
  TGenerated extends IsGenerated | NotGenerated = NotGenerated,
> {
  readonly _kind: 'column'
  readonly _type: TType
  readonly _nullable: TNullable
  readonly _default: TDefault
  readonly _primary: TPrimary
  readonly _generated: TGenerated
  readonly pgType: string
  readonly constraints: ColumnConstraint[]
  readonly references?: ForeignKeyRef
}

export interface ColumnConstraint {
  readonly type: 'not_null' | 'unique' | 'primary_key' | 'check' | 'default' | 'references' | 'generated'
  readonly value?: string
}

export interface ForeignKeyRef {
  readonly table: () => AnyTableDef
  readonly column: string
  readonly onDelete?: 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action'
  readonly onUpdate?: 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action'
}

// --- Relation Types ---

export type RelationKind = 'belongsTo' | 'hasOne' | 'hasMany' | 'hasManyThrough'

// RelationDef carries a phantom TResult type for typed includes.
// TResult is the row type of the target table (e.g. { id: number, title: string }).
// Defaults to Record<string, any> when no type param is provided.
// TNullable controls whether the resolved relation can be null (e.g. nullable FK in belongsTo).
export interface RelationDef<
  TKind extends RelationKind = RelationKind,
  TResult = Record<string, any>,
  TNullable extends boolean = false,
> {
  readonly _kind: 'relation'
  readonly type: TKind
  readonly targetTable: string
  readonly foreignKey: string
  // For through relations
  readonly throughTable?: string
  readonly throughFrom?: string
  readonly throughTo?: string
  // Phantom type for result inference
  readonly _result?: TResult
  readonly _nullable?: TNullable
}

// Relation builder interface — the `r` param in .withRelations() and defineTable()
// Pure type definition (no runtime code) — safe to keep in types module.
export interface RelationTypes {
  belongsTo: <TResult = Record<string, any>, TNullable extends boolean = false>(
    targetTable: string,
    foreignKey: string,
    opts?: { nullable: TNullable },
  ) => RelationDef<'belongsTo', TResult, TNullable>

  hasOne: <TResult = Record<string, any>, TNullable extends boolean = true>(
    targetTable: string,
    foreignKey: string,
    opts?: { nullable: TNullable },
  ) => RelationDef<'hasOne', TResult, TNullable>

  hasMany: <TResult = Record<string, any>>(
    targetTable: string,
    foreignKey: string,
  ) => RelationDef<'hasMany', TResult>

  hasManyThrough: <TResult = Record<string, any>>(
    targetTable: string,
    pivotTable: string,
    opts: { from: string, to: string },
  ) => RelationDef<'hasManyThrough', TResult>
}

// --- Index Definitions ---

export interface IndexDef {
  readonly columns: string[]
  readonly unique?: boolean
  readonly method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin'
  readonly where?: string
  readonly name?: string
}

// --- Virtual/Computed Fields ---

export interface VirtualDef<TRow = any, TResult = any> {
  readonly _kind: 'virtual'
  readonly compute: (row: TRow) => TResult
}

// --- Any-variant shorthands ---

export type AnyColumnDef = ColumnDef<any, any, any, any, any>
export type AnyColumns = Record<string, AnyColumnDef>
export type AnyRelationDef = RelationDef<any, any, any>
export type AnyRelations = Record<string, AnyRelationDef>
export type AnyVirtuals = Record<string, VirtualDef<any, any>>
export type AnyTableDef = TableDef<string, any, any, any>

// Table definition — the runtime object returned by defineTable
export interface TableDef<
  TName extends string = string,
  TColumns extends AnyColumns = AnyColumns,
  TRelations extends AnyRelations = AnyRelations,
  TVirtuals extends AnyVirtuals = AnyVirtuals,
> {
  readonly name: TName
  readonly columns: TColumns
  readonly relations: TRelations
  readonly virtuals: TVirtuals
  readonly hooks: { [E in HookEvent]?: HookHandler<TColumns, E>[] }
  readonly primaryKey: string | null
  readonly indexes: IndexDef[]
  readonly meta: Record<string, unknown>
  /** @internal */
  readonly _version: number
  hook: <E extends HookEvent>(event: E, handler: HookHandler<TColumns, E>) => this

  // Two-phase relation definition — avoids circular references.
  // Define all tables first, then call .withRelations() on each.
  // Both tables exist at that point, so InferEntity<typeof otherTable> works.
  withRelations: <TNewRels extends AnyRelations>(
    builder: (r: RelationTypes) => TNewRels,
  ) => TableDef<TName, TColumns, TNewRels, TVirtuals>

  // Two-phase virtual definition
  withVirtuals: <TVirtMap extends Record<string, (row: InferSelect<TColumns>) => any>>(
    virtuals: TVirtMap,
  ) => TableDef<TName, TColumns, TRelations, {
    [K in keyof TVirtMap]: VirtualDef<InferSelect<TColumns>, ReturnType<TVirtMap[K]>>
  }>

  // Add composite or multi-column indexes
  withIndexes: (indexes: IndexDef[]) => this

  // Apply a trait (composable table behavior)
  withTrait: <TNewCols extends AnyColumns = {}, TNewVirts extends AnyVirtuals = {}>(trait: Trait<TNewCols, TNewVirts>) => TableDef<TName, TColumns & TNewCols, TRelations, TVirtuals & TNewVirts>
}

export type HookEvent
  = | 'beforeInsert' | 'afterInsert'
    | 'beforeUpdate' | 'afterUpdate'
    | 'beforeDelete' | 'afterDelete'
    | 'afterSelect' | 'beforeUpsert'

export type HookHandler<TColumns extends AnyColumns, E extends HookEvent>
  = E extends 'afterSelect' ? (rows: InferSelect<TColumns>[]) => InferSelect<TColumns>[] | void | Promise<InferSelect<TColumns>[] | void>
    : E extends 'beforeInsert' | 'beforeUpsert' ? (row: InferInsert<TColumns>) => InferInsert<TColumns> | void | Promise<InferInsert<TColumns> | void>
      : E extends 'beforeUpdate' ? (row: Partial<InferSelect<TColumns>>) => Partial<InferSelect<TColumns>> | void | Promise<Partial<InferSelect<TColumns>> | void>
        : E extends 'afterInsert' | 'afterUpdate' | 'afterDelete' ? (rows: InferSelect<TColumns>[]) => void | Promise<void>
          : E extends 'beforeDelete' ? () => void | Promise<void>
            : never

export type HookRegistry = Partial<Record<HookEvent, ((...args: any[]) => any)[]>>

// --- Type inference utilities ---

type ExtractColumnType<C extends AnyColumnDef> = C['_type']
type IsColumnNullable<C extends AnyColumnDef> = C['_nullable'] extends IsNullable ? true : false
type IsColumnWithDefault<C extends AnyColumnDef> = C['_default'] extends HasDefault ? true : false
type IsColumnPrimaryKey<C extends AnyColumnDef> = C['_primary'] extends IsPrimaryKey ? true : false
type IsColumnGenerated<C extends AnyColumnDef> = C['_generated'] extends IsGenerated ? true : false

// InferPrimaryKey: extracts the type of the primary key column
export type PrimaryKeyColumn<TColumns extends AnyColumns> = {
  [K in keyof TColumns]: IsColumnPrimaryKey<TColumns[K]> extends true ? K : never
}[keyof TColumns]

export type InferPrimaryKey<TColumns extends AnyColumns>
  = ExtractColumnType<TColumns[PrimaryKeyColumn<TColumns>]>

/** Options controlling what a write operation returns. */
export interface WriteReturnOptions {
  /** Return the full entity (with virtuals applied) instead of just the primary key. */
  full?: boolean
}

// InferSelect: all columns, nullable columns get | null
export type InferSelect<TColumns extends AnyColumns> = {
  [K in keyof TColumns]: IsColumnNullable<TColumns[K]> extends true
    ? ExtractColumnType<TColumns[K]> | null
    : ExtractColumnType<TColumns[K]>
}

// InferInsert: optional for columns with defaults, primary keys, nullables, generated
export type InferInsert<TColumns extends AnyColumns>
  // Required columns
  = { [K in keyof TColumns as
    IsColumnNullable<TColumns[K]> extends true ? never
      : IsColumnWithDefault<TColumns[K]> extends true ? never
        : IsColumnPrimaryKey<TColumns[K]> extends true ? never
          : IsColumnGenerated<TColumns[K]> extends true ? never
            : K
    ]: ExtractColumnType<TColumns[K]> }
  // Optional columns (exclude generated — can't be inserted)
    & { [K in keyof TColumns as
      IsColumnGenerated<TColumns[K]> extends true ? never
        : IsColumnNullable<TColumns[K]> extends true ? K
          : IsColumnWithDefault<TColumns[K]> extends true ? K
            : IsColumnPrimaryKey<TColumns[K]> extends true ? K
              : never
      ]?: IsColumnNullable<TColumns[K]> extends true
        ? ExtractColumnType<TColumns[K]> | null
        : ExtractColumnType<TColumns[K]> }

// InferUpdate: all columns optional, generated excluded
export type InferUpdate<TColumns extends AnyColumns> = {
  [K in keyof TColumns as IsColumnGenerated<TColumns[K]> extends true ? never : K]?:
  IsColumnNullable<TColumns[K]> extends true
    ? ExtractColumnType<TColumns[K]> | null
    : ExtractColumnType<TColumns[K]>
}

// Where type: all columns available for filtering
export type InferWhere<TColumns extends AnyColumns> = {
  [K in keyof TColumns]?: IsColumnNullable<TColumns[K]> extends true
    ? ExtractColumnType<TColumns[K]> | null
    : ExtractColumnType<TColumns[K]>
}

// --- Relation result inference ---

// Map a RelationDef to its result type using the phantom TResult
// For belongsTo/hasOne, nullability depends on the TNullable flag (e.g. non-nullable FK → T, nullable FK → T | null)
export type InferRelationResult<R extends AnyRelationDef>
  = R extends RelationDef<'hasMany', infer T, any> ? T[]
    : R extends RelationDef<'hasManyThrough', infer T, any> ? T[]
      : R extends RelationDef<'belongsTo', infer T, infer N> ? N extends true ? T | null : T
        : R extends RelationDef<'hasOne', infer T, infer N> ? N extends true ? T | null : T
          : never

// Merge base select type with included relation results
export type WithIncludes<
  TBase,
  TRelations extends AnyRelations,
  TIncluded extends keyof TRelations,
> = TBase & {
  [K in TIncluded]: InferRelationResult<TRelations[K]>
}

// Extract just the virtual field types from a virtuals map
export type InferVirtuals<TVirtuals extends AnyVirtuals> = {
  [K in keyof TVirtuals]: TVirtuals[K] extends VirtualDef<any, infer TResult> ? TResult : never
}

// Merge column select type with virtual field results
export type WithVirtuals<TColumns extends AnyColumns, TVirtuals extends AnyVirtuals>
  = InferSelect<TColumns> & InferVirtuals<TVirtuals>

// --- Helpers to infer from a TableDef ---

// Short alias — infer the entity (row) type from a table definition (includes virtuals)
export type InferEntity<T extends AnyTableDef> = WithVirtuals<T['columns'], T extends TableDef<any, any, any, infer V> ? V : {}>

export type InferSelectFromTable<T extends AnyTableDef> = InferSelect<T['columns']>
export type InferInsertFromTable<T extends AnyTableDef> = InferInsert<T['columns']>
export type InferUpdateFromTable<T extends AnyTableDef> = InferUpdate<T['columns']>

// Column name extraction
export type ColumnNames<T extends AnyTableDef> = keyof T['columns'] & string

// Extract the TS type of a specific column
export type ColumnType<T extends AnyTableDef, K extends ColumnNames<T>>
  = ExtractColumnType<T['columns'][K]>
