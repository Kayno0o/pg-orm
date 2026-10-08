import type { Trait } from '../traits/index'
import type { AnyColumnDef, AnyRelationDef, AnyRelations, AnyTableDef, AnyVirtuals, ColumnDef, HookEvent, HookRegistry, IndexDef, InferSelect, RelationTypes, TableDef, UniqueDef, VirtualDef } from '../types/index'
import type { ColumnTypes } from './column-types'
import { ValidationError } from '../errors/index'
import { compileMapper } from '../mapper/index'
import { applyTrait } from '../traits/index'
import { createColumnTypes } from './column-types'
import { ColumnBuilder, getColumnIndex } from './columns'
import { createRelationTypes } from './relations'
import { validateIdentifier, validateIndexMethod, validateRawSqlFragment } from './validate'

// Registered globally so a table defined by another copy of the lib (a bundled dependency) still passes `isTableDef`.
const TABLE_DEF: unique symbol = Symbol.for('pg-orm.TableDef') as never

/** Whether `value` was built by `defineTable`, for code that discovers tables among a module's exports. */
export function isTableDef(value: unknown): value is AnyTableDef {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[TABLE_DEF] === true
}

// Type-level: extract column definitions from the builder callback return type
type ExtractColumns<T extends Record<string, ColumnBuilder>> = {
  [K in keyof T]: T[K] extends ColumnBuilder<infer TType, infer TNullable, infer TDefault, infer TPrimary, infer TGenerated>
    ? ColumnDef<TType, TNullable, TDefault, TPrimary, TGenerated>
    : never
}

// Type-level: extract virtual definitions from the virtuals map
type ExtractVirtuals<TColumns extends Record<string, AnyColumnDef>, TVirt extends Record<string, (row: any) => any>> = {
  [K in keyof TVirt]: VirtualDef<InferSelect<TColumns>, ReturnType<TVirt[K]>>
}

// Find primary key column name(s) from column definitions
function findPrimaryKey(columns: Record<string, AnyColumnDef>): string | null {
  const pks: string[] = []

  for (const [name, col] of Object.entries(columns)) {
    if (col.constraints.some((c: { type: string }) => c.type === 'primary_key'))
      pks.push(name)
  }

  return pks.length === 1 ? pks[0]! : pks.length > 1 ? pks.join(',') : null
}

function buildColumns(builders: Record<string, ColumnBuilder>): { columns: Record<string, AnyColumnDef>, indexes: IndexDef[] } {
  const columns = {} as Record<string, AnyColumnDef>
  const indexes: IndexDef[] = []

  for (const key in builders) {
    validateIdentifier(key, 'column')
    const b = builders[key]

    if (b instanceof ColumnBuilder) {
      columns[key] = b._build()

      const idx = getColumnIndex(b)

      if (idx) {
        if (idx.where !== undefined)
          validateRawSqlFragment(idx.where, `index on "${key}"`)

        indexes.push({ columns: [key], unique: false, method: idx.method, where: idx.where, ...idx.concurrently ? { concurrently: true } : {} })
      }
    }
  }

  return { columns, indexes }
}

function buildVirtualDefs(virtuals?: Record<string, (row: any) => any>): AnyVirtuals {
  const defs: AnyVirtuals = {}

  if (virtuals) {
    for (const key in virtuals)
      defs[key] = { _kind: 'virtual', compute: virtuals[key]! } as VirtualDef
  }

  return defs
}

/**
 * Define a table schema with typed columns, optional relations, and optional virtuals.
 * Returns a frozen TableDef used by `Database`, `Repository`, and the migration system.
 *
 * @example
 * ```ts
 * const users = defineTable('users', t => ({
 *   id: t.serial().primaryKey(),
 *   name: t.text().notNull(),
 *   email: t.varchar(255).notNull().unique(),
 * }))
 * ```
 */
// Overload 1: columns only
export function defineTable<
  TName extends string,
  TBuilders extends Record<string, ColumnBuilder<unknown, any, any, any, any>>,
>(
  name: TName,
  columnBuilder: (t: ColumnTypes) => TBuilders,
): TableDef<TName, ExtractColumns<TBuilders>, {}, {}>

// Overload 2: columns + relations
export function defineTable<
  TName extends string,
  TBuilders extends Record<string, ColumnBuilder<unknown, any, any, any, any>>,
  TRelBuilders extends Record<string, AnyRelationDef>,
>(
  name: TName,
  columnBuilder: (t: ColumnTypes) => TBuilders,
  relationBuilder: (r: RelationTypes) => TRelBuilders,
): TableDef<TName, ExtractColumns<TBuilders>, TRelBuilders, {}>

// Overload 3: columns + relations + virtuals
export function defineTable<
  TName extends string,
  TBuilders extends Record<string, ColumnBuilder<unknown, any, any, any, any>>,
  TRelBuilders extends Record<string, AnyRelationDef>,
  TVirtBuilders extends Record<string, (row: InferSelect<ExtractColumns<TBuilders>>) => any>,
>(
  name: TName,
  columnBuilder: (t: ColumnTypes) => TBuilders,
  relationBuilder: (r: RelationTypes) => TRelBuilders,
  virtuals: TVirtBuilders,
): TableDef<TName, ExtractColumns<TBuilders>, TRelBuilders, ExtractVirtuals<ExtractColumns<TBuilders>, TVirtBuilders>>

// Implementation
export function defineTable(
  name: string,
  columnBuilder: (t: ColumnTypes) => Record<string, ColumnBuilder>,
  relationBuilder?: (r: RelationTypes) => Record<string, AnyRelationDef>,
  virtuals?: Record<string, (row: any) => any>,
): AnyTableDef {
  validateIdentifier(name, 'table')

  const builders = columnBuilder(createColumnTypes())
  const { columns, indexes } = buildColumns(builders)
  const relations: AnyRelations = relationBuilder ? relationBuilder(createRelationTypes()) as AnyRelations : {}
  const virtualDefs = buildVirtualDefs(virtuals)
  const hooks: HookRegistry = {}
  const meta: Record<string, unknown> = {}

  const table: Record<string, unknown> = {
    name,
    columns,
    relations,
    virtuals: virtualDefs,
    hooks,
    primaryKey: findPrimaryKey(columns),
    indexes,
    uniques: [] as UniqueDef[],
    meta,
    _version: 0,
    hook(event: HookEvent, handler: (...args: unknown[]) => unknown) {
      hooks[event] ||= []
      hooks[event].push(handler)
      bump()

      return table
    },

    // Two-phase: add relations after all tables are defined
    withRelations(builder: (r: RelationTypes) => AnyRelations) {
      const r = createRelationTypes()

      table.relations = Object.assign(table.relations ?? {}, builder(r))
      bump()

      return table
    },

    // Two-phase: add virtuals after table is defined
    withVirtuals(virts: Record<string, (row: any) => any>) {
      const existing = (table.virtuals ?? {}) as Record<string, VirtualDef>

      for (const key in virts) {
        existing[key] = { _kind: 'virtual', compute: virts[key]! } as VirtualDef
      }

      table.virtuals = existing
      bump()

      return table
    },

    // Add composite or multi-column indexes
    withIndexes(idxDefs: IndexDef[]) {
      for (const idx of idxDefs) {
        if (idx.name !== undefined)
          validateIdentifier(idx.name, 'index')

        for (const col of [...idx.columns, ...idx.desc ?? [], ...idx.include ?? [], ...Object.keys(idx.opclass ?? {})])
          validateIdentifier(col, 'index column')

        for (const opclass of Object.values(idx.opclass ?? {}))
          validateIdentifier(opclass, 'index operator class')

        if (idx.expressions?.length && idx.name === undefined)
          throw new ValidationError(`An index on expressions needs a name: ${idx.expressions.join(', ')}`, 'index', { value: idx.expressions })

        validateIndexMethod(idx.method, `index "${idx.name ?? idx.columns.join('_')}"`)

        if (idx.where !== undefined)
          validateRawSqlFragment(idx.where, `index "${idx.name ?? idx.columns.join('_')}"`)
      }
      ;(table.indexes as IndexDef[]).push(...idxDefs)
      bump()

      return table
    },

    withUnique(columns: string[], name?: string) {
      for (const col of columns)
        validateIdentifier(col, 'unique column')

      if (name !== undefined)
        validateIdentifier(name, 'unique constraint')

      ;(table.uniques as UniqueDef[]).push({ columns, name })
      bump()

      return table
    },

    withComment(comment: string) {
      table.comment = comment
      bump()

      return table
    },

    renamedFrom(oldName: string) {
      validateIdentifier(oldName, 'renamedFrom table')
      table.previousName = oldName
      bump()

      return table
    },

    // Apply a trait — merges columns, hooks, virtuals, and meta
    withTrait(trait: Trait<any>) {
      applyTrait(table as unknown as AnyTableDef, trait)
      bump()

      return table
    },
  }

  // Invalidates repositories cached against this table def (see Database.repo).
  function bump(): void {
    table._version = (table._version as number) + 1
  }

  Object.defineProperty(table, TABLE_DEF, { value: true })

  // Pre-compile default JIT mapper at defineTable() time
  compileMapper(columns)

  return table as unknown as AnyTableDef
}
