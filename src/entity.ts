import type { ORM } from './orm'
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
  ScopeDefinition,
  TraitDefinition,
} from './types'
import { SchemaMetadata } from './schema-metadata'
import { validateSQLIdentifier } from './sql-utils'

/**
 * Builder class for defining entity schemas and behaviors.
 * Supports fluent API for adding hooks, traits, and scopes.
 */
export class EntityBuilder<
  T extends EntitySchema,
  TTraits extends readonly TraitDefinition<any, any>[] = readonly [],
  TScopes extends string = never,
> {
  private _hooks: EntityHooks<T>
  private _traits: TTraits
  private _unique?: string[][]
  private _scopes: Map<string, ScopeDefinition<T>>
  private orm?: ORM

  constructor(
    private readonly tableName: string,
    private readonly schema: T,
    traits: TTraits = [] as any,
    orm?: ORM,
  ) {
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
    this._scopes = new Map()
    this.orm = orm
  }

  /**
   * Registers a hook to run before creating an entity instance.
   * @param hook - The hook function.
   */
  beforeCreate(hook: BeforeCreateHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeCreate.push(hook)

    return newBuilder
  }

  /**
   * Registers a hook to run after creating an entity instance.
   * @param hook - The hook function.
   */
  afterCreate(hook: AfterCreateHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterCreate.push(hook)

    return newBuilder
  }

  /**
   * Registers a hook to run before updating an entity instance.
   * @param hook - The hook function.
   */
  beforeUpdate(hook: BeforeUpdateHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeUpdate.push(hook)

    return newBuilder
  }

  /**
   * Registers a hook to run after updating an entity instance.
   * @param hook - The hook function.
   */
  afterUpdate(hook: AfterUpdateHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterUpdate.push(hook)

    return newBuilder
  }

  /**
   * Registers a hook to run before deleting an entity instance.
   * @param hook - The hook function.
   */
  beforeDelete(hook: BeforeDeleteHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeDelete.push(hook)

    return newBuilder
  }

  /**
   * Registers a hook to run after deleting an entity instance.
   * @param hook - The hook function.
   */
  afterDelete(hook: AfterDeleteHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterDelete.push(hook)

    return newBuilder
  }

  /**
   * Mixes in a trait to the entity definition.
   * @param trait - The trait definition to apply.
   */
  use<TraitFields extends EntitySchema, TraitMethods extends Record<string, any>>(
    trait: TraitDefinition<TraitFields, TraitMethods>,
  ): EntityBuilder<T & TraitFields, readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>], TScopes> {
    const newSchema = { ...this.schema, ...trait.fields } as T & TraitFields
    const newTraits = [...this._traits, trait] as unknown as readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>]
    const newBuilder = new EntityBuilder<T & TraitFields, readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>], TScopes>(
      this.tableName,
      newSchema,
      newTraits,
      this.orm,
    )

    newBuilder._hooks = {
      beforeCreate: [...this._hooks.beforeCreate, ...(trait.hooks?.beforeCreate || [])],
      afterCreate: [...this._hooks.afterCreate, ...(trait.hooks?.afterCreate || [])],
      beforeUpdate: [...this._hooks.beforeUpdate, ...(trait.hooks?.beforeUpdate || [])],
      afterUpdate: [...this._hooks.afterUpdate, ...(trait.hooks?.afterUpdate || [])],
      beforeDelete: [...this._hooks.beforeDelete, ...(trait.hooks?.beforeDelete || [])],
      afterDelete: [...this._hooks.afterDelete, ...(trait.hooks?.afterDelete || [])],
    } as EntityHooks<T & TraitFields>
    newBuilder._unique = this._unique
    newBuilder._scopes = this._scopes as any

    return newBuilder
  }

  /**
   * Defines unique constraints on the entity.
   * @param columns - Array of column combinations that must be unique.
   */
  unique(...columns: (keyof T)[][]): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._unique = columns.map(cols => cols.map(String))

    return newBuilder
  }

  /**
   * Defines a named query scope for the entity.
   * @param name - The name of the scope.
   * @param scopeFn - The function defining the scope logic.
   */
  scope<Name extends string>(name: Name, scopeFn: ScopeDefinition<T>): EntityBuilder<T, TTraits, TScopes | Name> {
    const newBuilder = this.clone()

    newBuilder._scopes.set(name, scopeFn)

    return newBuilder as unknown as EntityBuilder<T, TTraits, TScopes | Name>
  }

  /**
   * Finalizes the entity definition.
   * @returns The immutable entity definition object.
   */
  build(): EntityDefinition<T, TTraits, TScopes> {
    const entityDef = Object.freeze({
      tableName: this.tableName,
      schema: this.schema,
      hooks: this._hooks,
      traits: this._traits,
      unique: this._unique,
      scopes: this._scopes,
      metadata: new SchemaMetadata(this.tableName, this.schema),
    })

    if (this.orm) {
      this.orm.registerEntity(entityDef)
    }

    return entityDef
  }

  private clone(): EntityBuilder<T, TTraits, TScopes> {
    const cloned = new EntityBuilder<T, TTraits, TScopes>(
      this.tableName,
      { ...this.schema },
      this._traits,
      this.orm,
    )

    cloned._hooks = {
      beforeCreate: [...this._hooks.beforeCreate],
      afterCreate: [...this._hooks.afterCreate],
      beforeUpdate: [...this._hooks.beforeUpdate],
      afterUpdate: [...this._hooks.afterUpdate],
      beforeDelete: [...this._hooks.beforeDelete],
      afterDelete: [...this._hooks.afterDelete],
    }
    cloned._unique = this._unique
    cloned._scopes = new Map(this._scopes)

    return cloned
  }
}

/**
 * Converts a field definition object into an entity schema.
 * @param fields - Object map of field builders.
 *
 * Note: We use `any` in the constraint instead of `FieldConfig` to preserve exact type information.
 * With `{ toConfig(): FieldConfig }`, TypeScript widens specific types like `StringFieldConfig<'a' | 'b', false, false>`
 * to the union type `FieldConfig`, losing generic parameters. Using `any` allows TypeScript to infer
 * the exact return type while `ReturnType` preserves type safety.
 */
export function createEntitySchema<T extends Record<string, { toConfig: () => any }>>(
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
