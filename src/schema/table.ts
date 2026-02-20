import type { AnyColumnDef, AnyRelationDef, AnyRelations, AnyTableDef, AnyVirtuals, HookEvent, HookRegistry, InferSelect, RelationTypes, TableDef, VirtualDef } from '../types/index'
import type { ColumnTypes } from './columns'
import { compileMapper } from '../mapper/index'
import { ColumnBuilder, createColumnTypes } from './columns'
import { createRelationTypes } from './relations'
import { validateIdentifier } from './validate'

// Type-level: extract column definitions from the builder callback return type
type ExtractColumns<T extends Record<string, ColumnBuilder>> = {
  [K in keyof T]: T[K] extends ColumnBuilder<infer TType, infer TNullable, infer TDefault, infer TPrimary, infer TGenerated>
    ? import('../types/index').ColumnDef<TType, TNullable, TDefault, TPrimary, TGenerated>
    : never
}

// Type-level: extract virtual definitions from the virtuals map
type ExtractVirtuals<TColumns extends Record<string, AnyColumnDef>, TVirt extends Record<string, (row: any) => any>> = {
  [K in keyof TVirt]: VirtualDef<InferSelect<TColumns>, ReturnType<TVirt[K]>>
}

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
  // Validate table name at definition time
  validateIdentifier(name, 'table')

  const t = createColumnTypes()
  const builders = columnBuilder(t)

  const columns = {} as Record<string, AnyColumnDef>

  for (const key in builders) {
    validateIdentifier(key, 'column')
    const b = builders[key]

    if (b instanceof ColumnBuilder) {
      columns[key] = b._build()
    }
  }

  // Build relations if provided inline
  let relations: AnyRelations = {}

  if (relationBuilder) {
    const r = createRelationTypes()

    relations = relationBuilder(r) as AnyRelations
  }

  // Build virtuals if provided inline
  const virtualDefs: AnyVirtuals = {}

  if (virtuals) {
    for (const key in virtuals) {
      virtualDefs[key] = { _kind: 'virtual', compute: virtuals[key]! } as VirtualDef
    }
  }

  const hooks: HookRegistry = {}

  const table: Record<string, unknown> = {
    name,
    columns: Object.freeze(columns),
    relations,
    virtuals: virtualDefs,
    hooks,
    hook(event: HookEvent, handler: (...args: unknown[]) => unknown) {
      hooks[event] ||= []
      hooks[event]!.push(handler)
    },

    // Two-phase: add relations after all tables are defined
    withRelations(builder: (r: RelationTypes) => AnyRelations) {
      const r = createRelationTypes()

      table.relations = builder(r)

      return table
    },

    // Two-phase: add virtuals after table is defined
    withVirtuals(virts: Record<string, (row: any) => any>) {
      const newVirtuals: AnyVirtuals = {}

      for (const key in virts) {
        newVirtuals[key] = { _kind: 'virtual', compute: virts[key]! } as VirtualDef
      }

      table.virtuals = newVirtuals

      return table
    },
  }

  // Pre-compile default JIT mapper at defineTable() time
  compileMapper(columns)

  return table as unknown as AnyTableDef
}
