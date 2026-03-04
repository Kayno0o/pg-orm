import type { Trait } from '../traits/index'
import type { AnyColumnDef, AnyRelationDef, AnyRelations, AnyTableDef, AnyVirtuals, ColumnDef, HookEvent, HookRegistry, IndexDef, InferSelect, RelationTypes, TableDef, VirtualDef } from '../types/index'
import type { ColumnTypes } from './columns'
import { compileMapper } from '../mapper/index'
import { applyTrait } from '../traits/index'
import { ColumnBuilder, createColumnTypes } from './columns'
import { createRelationTypes } from './relations'
import { validateIdentifier } from './validate'

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

      if ((b as unknown as { _index?: object })._index) {
        const idx = (b as unknown as { _index: { method?: IndexDef['method'], where?: string } })._index

        indexes.push({ columns: [key], unique: false, method: idx.method, where: idx.where })
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
  TBuilders extends Record<string, ColumnBuilder<any, any, any, any, any>>,
>(
  name: TName,
  columnBuilder: (t: ColumnTypes) => TBuilders,
): TableDef<TName, ExtractColumns<TBuilders>, {}, {}>

// Overload 2: columns + relations
export function defineTable<
  TName extends string,
  TBuilders extends Record<string, ColumnBuilder<any, any, any, any, any>>,
  TRelBuilders extends Record<string, AnyRelationDef>,
>(
  name: TName,
  columnBuilder: (t: ColumnTypes) => TBuilders,
  relationBuilder: (r: RelationTypes) => TRelBuilders,
): TableDef<TName, ExtractColumns<TBuilders>, TRelBuilders, {}>

// Overload 3: columns + relations + virtuals
export function defineTable<
  TName extends string,
  TBuilders extends Record<string, ColumnBuilder<any, any, any, any, any>>,
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
    meta,
    hook(event: HookEvent, handler: (...args: unknown[]) => unknown) {
      hooks[event] ||= []
      hooks[event]!.push(handler)

      return table
    },

    // Two-phase: add relations after all tables are defined
    withRelations(builder: (r: RelationTypes) => AnyRelations) {
      const r = createRelationTypes()

      table.relations = Object.assign(table.relations ?? {}, builder(r))

      return table
    },

    // Two-phase: add virtuals after table is defined
    withVirtuals(virts: Record<string, (row: any) => any>) {
      const existing = (table.virtuals ?? {}) as Record<string, VirtualDef>

      for (const key in virts) {
        existing[key] = { _kind: 'virtual', compute: virts[key]! } as VirtualDef
      }

      table.virtuals = existing

      return table
    },

    // Add composite or multi-column indexes
    withIndexes(idxDefs: IndexDef[]) {
      ;(table.indexes as IndexDef[]).push(...idxDefs)

      return table
    },

    // Apply a trait — merges columns, hooks, virtuals, and meta
    withTrait(trait: Trait<any>) {
      applyTrait(table as unknown as AnyTableDef, trait)

      return table
    },
  }

  // Pre-compile default JIT mapper at defineTable() time
  compileMapper(columns)

  return table as unknown as AnyTableDef
}
