import type {
  AfterCreateHook,
  AfterDeleteHook,
  AfterUpdateHook,
  BeforeCreateHook,
  BeforeDeleteHook,
  BeforeUpdateHook,
  EntityDefinition,
  EntityHooks,
  EntitySchema,
  FieldConfig,
  TraitDefinition,
} from './types'
import { validateSQLIdentifier } from './sql-utils'

// ============================================================================
// Entity Builder
// ============================================================================

export class EntityBuilder<
  T extends EntitySchema,
  TTraits extends readonly TraitDefinition<any, any>[] = readonly [],
> {
  private _hooks: EntityHooks<T>
  private _traits: TTraits
  private _unique?: string[][]

  constructor(
    private readonly tableName: string,
    private readonly schema: T,
    traits: TTraits = [] as any,
  ) {
    // Validate table name on construction to prevent SQL injection
    validateSQLIdentifier(tableName, 'table')

    this._hooks = {
      beforeCreate: [],
      afterCreate: [],
      beforeUpdate: [],
      afterUpdate: [],
      beforeDelete: [],
      afterDelete: [],
    }
    this._traits = traits
  }

  // ========================================================================
  // Lifecycle Hooks
  // ========================================================================

  beforeCreate(hook: BeforeCreateHook<T>): EntityBuilder<T, TTraits> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeCreate.push(hook)

    return newBuilder
  }

  afterCreate(hook: AfterCreateHook<T>): EntityBuilder<T, TTraits> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterCreate.push(hook)

    return newBuilder
  }

  beforeUpdate(hook: BeforeUpdateHook<T>): EntityBuilder<T, TTraits> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeUpdate.push(hook)

    return newBuilder
  }

  afterUpdate(hook: AfterUpdateHook<T>): EntityBuilder<T, TTraits> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterUpdate.push(hook)

    return newBuilder
  }

  beforeDelete(hook: BeforeDeleteHook<T>): EntityBuilder<T, TTraits> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeDelete.push(hook)

    return newBuilder
  }

  afterDelete(hook: AfterDeleteHook<T>): EntityBuilder<T, TTraits> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterDelete.push(hook)

    return newBuilder
  }

  // ========================================================================
  // Traits
  // ========================================================================

  use<TraitFields extends EntitySchema, TraitMethods extends Record<string, any>>(
    trait: TraitDefinition<TraitFields, TraitMethods>,
  ): EntityBuilder<T & TraitFields, readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>]> {
    // Merge trait fields into schema
    const newSchema = { ...this.schema, ...trait.fields } as T & TraitFields

    // Create new traits array with the new trait
    const newTraits = [...this._traits, trait] as unknown as readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>]

    const newBuilder = new EntityBuilder(this.tableName, newSchema, newTraits)

    // Copy hooks (type cast needed for trait field additions)
    newBuilder._hooks = {
      beforeCreate: [...this._hooks.beforeCreate] as any,
      afterCreate: [...this._hooks.afterCreate] as any,
      beforeUpdate: [...this._hooks.beforeUpdate] as any,
      afterUpdate: [...this._hooks.afterUpdate] as any,
      beforeDelete: [...this._hooks.beforeDelete] as any,
      afterDelete: [...this._hooks.afterDelete] as any,
    }
    newBuilder._unique = this._unique

    return newBuilder
  }

  // ========================================================================
  // Constraints
  // ========================================================================

  unique(...columns: (keyof T)[][]): EntityBuilder<T, TTraits> {
    const newBuilder = this.clone()

    newBuilder._unique = columns.map(cols => cols.map(String))

    return newBuilder
  }

  // ========================================================================
  // Build Final Definition
  // ========================================================================

  build(): EntityDefinition<T, TTraits> {
    return Object.freeze({
      tableName: this.tableName,
      schema: this.schema,
      hooks: this._hooks,
      traits: this._traits,
      unique: this._unique,
    })
  }

  // ========================================================================
  // Internal Helpers
  // ========================================================================

  private clone(): EntityBuilder<T, TTraits> {
    const cloned = new EntityBuilder(this.tableName, { ...this.schema }, this._traits)

    cloned._hooks = {
      beforeCreate: [...this._hooks.beforeCreate],
      afterCreate: [...this._hooks.afterCreate],
      beforeUpdate: [...this._hooks.beforeUpdate],
      afterUpdate: [...this._hooks.afterUpdate],
      beforeDelete: [...this._hooks.beforeDelete],
      afterDelete: [...this._hooks.afterDelete],
    }
    cloned._unique = this._unique

    return cloned
  }
}

// ============================================================================
// Helper: Extract schema from field builders
// ============================================================================

export function createEntitySchema<T extends Record<string, { toConfig: () => FieldConfig }>>(
  fields: T,
): {
  [K in keyof T]: ReturnType<T[K]['toConfig']>
} {
  const schema: any = {}

  for (const [key, builder] of Object.entries(fields)) {
    schema[key] = builder.toConfig()
  }

  return schema
}
