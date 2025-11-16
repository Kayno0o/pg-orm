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
  InferEntity,
  TraitDefinition,
} from './types'

// ============================================================================
// Entity Builder
// ============================================================================

export class EntityBuilder<T extends EntitySchema> {
  private _hooks: EntityHooks<T>
  private _traits: TraitDefinition[]
  private _unique?: string[][]

  constructor(
    private readonly tableName: string,
    private readonly schema: T,
  ) {
    this._hooks = {
      beforeCreate: [],
      afterCreate: [],
      beforeUpdate: [],
      afterUpdate: [],
      beforeDelete: [],
      afterDelete: [],
    }
    this._traits = []
  }

  // ========================================================================
  // Lifecycle Hooks
  // ========================================================================

  beforeCreate(hook: BeforeCreateHook<T>): EntityBuilder<T> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeCreate.push(hook)

    return newBuilder
  }

  afterCreate(hook: AfterCreateHook<T>): EntityBuilder<T> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterCreate.push(hook)

    return newBuilder
  }

  beforeUpdate(hook: BeforeUpdateHook<T>): EntityBuilder<T> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeUpdate.push(hook)

    return newBuilder
  }

  afterUpdate(hook: AfterUpdateHook<T>): EntityBuilder<T> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterUpdate.push(hook)

    return newBuilder
  }

  beforeDelete(hook: BeforeDeleteHook<T>): EntityBuilder<T> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeDelete.push(hook)

    return newBuilder
  }

  afterDelete(hook: AfterDeleteHook<T>): EntityBuilder<T> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterDelete.push(hook)

    return newBuilder
  }

  // ========================================================================
  // Traits
  // ========================================================================

  use<
    TraitFields extends EntitySchema,
    Methods extends Record<string, (this: InferEntity<T & TraitFields>, ...args: any[]) => any>,
  >(
    trait: TraitDefinition<Methods> & { fields?: TraitFields },
  ): EntityBuilder<T & TraitFields> {
    const newBuilder = this.clone() as any

    newBuilder._traits.push(trait)

    // Merge trait fields into schema
    if (trait.fields) {
      Object.assign(newBuilder.schema, trait.fields)
    }

    // Merge trait hooks
    if (trait.methods) {
      // Methods will be injected into entity instances by the repository
    }

    return newBuilder as EntityBuilder<T & TraitFields>
  }

  // ========================================================================
  // Constraints
  // ========================================================================

  unique(...columns: (keyof T)[][]): EntityBuilder<T> {
    const newBuilder = this.clone()

    newBuilder._unique = columns.map(cols => cols.map(String))

    return newBuilder
  }

  // ========================================================================
  // Build Final Definition
  // ========================================================================

  build(): EntityDefinition<T> {
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

  private clone(): EntityBuilder<T> {
    const cloned = new EntityBuilder(this.tableName, { ...this.schema })

    cloned._hooks = {
      beforeCreate: [...this._hooks.beforeCreate],
      afterCreate: [...this._hooks.afterCreate],
      beforeUpdate: [...this._hooks.beforeUpdate],
      afterUpdate: [...this._hooks.afterUpdate],
      beforeDelete: [...this._hooks.beforeDelete],
      afterDelete: [...this._hooks.afterDelete],
    }
    cloned._traits = [...this._traits]
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
