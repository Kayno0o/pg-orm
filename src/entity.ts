import type { ORM } from './orm'
import type { RelationConfig, RelationSchema } from './relations/types'
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
import { validateSQLIdentifier } from './sql-utils'

/**
 * Builder class for defining entity schemas and behaviors.
 * Supports fluent API for adding hooks, traits, and scopes.
 */
export class EntityBuilder<
  T extends EntitySchema,
  TTraits extends readonly TraitDefinition<any, any>[] = readonly [],
  TScopes extends string = never,

  TRelations extends RelationSchema = {},
> {
  private _hooks: EntityHooks<T>
  private _traits: TTraits
  private _unique?: string[][]
  private _scopes: Map<string, ScopeDefinition<T>>
  private _relations: TRelations
  private orm?: ORM

  constructor(
    private readonly tableName: string,
    private readonly schema: T,
    traits: TTraits = [] as any,
    relations: TRelations = {} as any,
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
    this._relations = relations
    this.orm = orm
  }

  /**
   * Registers a hook to run before creating an entity instance.
   * @param hook - The hook function.
   */
  beforeCreate(hook: BeforeCreateHook<T>): EntityBuilder<T, TTraits, TScopes, TRelations> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeCreate.push(hook)

    return newBuilder
  }

  /**
   * Registers a hook to run after creating an entity instance.
   * @param hook - The hook function.
   */
  afterCreate(hook: AfterCreateHook<T>): EntityBuilder<T, TTraits, TScopes, TRelations> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterCreate.push(hook)

    return newBuilder
  }

  /**
   * Registers a hook to run before updating an entity instance.
   * @param hook - The hook function.
   */
  beforeUpdate(hook: BeforeUpdateHook<T>): EntityBuilder<T, TTraits, TScopes, TRelations> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeUpdate.push(hook)

    return newBuilder
  }

  /**
   * Registers a hook to run after updating an entity instance.
   * @param hook - The hook function.
   */
  afterUpdate(hook: AfterUpdateHook<T>): EntityBuilder<T, TTraits, TScopes, TRelations> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterUpdate.push(hook)

    return newBuilder
  }

  /**
   * Registers a hook to run before deleting an entity instance.
   * @param hook - The hook function.
   */
  beforeDelete(hook: BeforeDeleteHook<T>): EntityBuilder<T, TTraits, TScopes, TRelations> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeDelete.push(hook)

    return newBuilder
  }

  /**
   * Registers a hook to run after deleting an entity instance.
   * @param hook - The hook function.
   */
  afterDelete(hook: AfterDeleteHook<T>): EntityBuilder<T, TTraits, TScopes, TRelations> {
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
  ): EntityBuilder<T & TraitFields, readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>], TScopes, TRelations> {
    const newSchema = { ...this.schema, ...trait.fields } as T & TraitFields
    const newTraits = [...this._traits, trait] as unknown as readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>]
    const newBuilder = new EntityBuilder<T & TraitFields, readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>], TScopes, TRelations>(
      this.tableName,
      newSchema,
      newTraits,
      this._relations,
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
  unique(...columns: (keyof T)[][]): EntityBuilder<T, TTraits, TScopes, TRelations> {
    const newBuilder = this.clone()

    newBuilder._unique = columns.map(cols => cols.map(String))

    return newBuilder
  }

  /**
   * Defines a named query scope for the entity.
   * @param name - The name of the scope.
   * @param scopeFn - The function defining the scope logic.
   */
  scope<Name extends string>(name: Name, scopeFn: ScopeDefinition<T>): EntityBuilder<T, TTraits, TScopes | Name, TRelations> {
    const newBuilder = this.clone()

    newBuilder._scopes.set(name, scopeFn)

    return newBuilder as unknown as EntityBuilder<T, TTraits, TScopes | Name, TRelations>
  }

  /**
   * Defines relations for the entity.
   * @param relationDefs - Object mapping relation names to relation builders.
   */
  relations<R extends Record<string, { toConfig: () => RelationConfig<any, any> }>>(
    relationDefs: R,
  ): EntityBuilder<
    T,
    TTraits,
    TScopes,
    TRelations & { [K in keyof R]: ReturnType<R[K]['toConfig']> }
  > {
    const relationConfigs: any = {}

    for (const [key, builder] of Object.entries(relationDefs)) {
      // Check for name conflicts with schema fields
      if (key in this.schema) {
        throw new Error(
          `Relation name "${key}" conflicts with existing field in "${this.tableName}". `
          + `Please choose a different name for the relation.`,
        )
      }

      relationConfigs[key] = builder.toConfig()
    }

    const newBuilder = new EntityBuilder(
      this.tableName,
      this.schema,
      this._traits,
      { ...this._relations, ...relationConfigs },
      this.orm,
    )

    newBuilder._hooks = this._hooks
    newBuilder._unique = this._unique
    newBuilder._scopes = this._scopes as any

    return newBuilder as EntityBuilder<T, TTraits, TScopes, TRelations & { [K in keyof R]: ReturnType<R[K]['toConfig']> }>
  }

  /**
   * Finalizes the entity definition.
   * @returns The immutable entity definition object.
   */
  build(): EntityDefinition<T, TTraits, TScopes, TRelations> {
    // Only validate relations if there are any defined
    if (Object.keys(this._relations).length > 0) {
      // Check ORM context exists BEFORE looping
      if (!this.orm) {
        throw new Error(
          `Cannot define relations without ORM context. Use orm.entity() instead of new EntityBuilder()`,
        )
      }

      // Validate all relations at build time
      for (const config of Object.values(this._relations)) {
        // 1. Validate SQL identifiers for all relation components
        validateSQLIdentifier(config.tableName, 'table')
        validateSQLIdentifier(config.foreignKey, 'column')

        if (config.type === 'manyToMany') {
          validateSQLIdentifier(config.through, 'table')
          validateSQLIdentifier(config.throughForeignKey, 'column')
          validateSQLIdentifier(config.otherKey, 'column')
        }

        if (config.type === 'belongsTo' && config.ownerKey) {
          validateSQLIdentifier(config.ownerKey, 'column')
        }

        // 2. For belongsTo relations, validate that foreign key exists in THIS schema
        if (config.type === 'belongsTo') {
          if (!(config.foreignKey in this.schema)) {
            throw new Error(
              `Foreign key "${config.foreignKey}" not found in schema for "${this.tableName}". `
              + `Did you forget to add it as a field?`,
            )
          }
        }
      }
    }

    const entityDef = Object.freeze({
      tableName: this.tableName,
      schema: this.schema,
      hooks: this._hooks,
      traits: this._traits,
      unique: this._unique,
      scopes: this._scopes,
      relations: this._relations,
    })

    if (this.orm) {
      this.orm.registerEntity(entityDef)
    }

    return entityDef
  }

  private clone(): EntityBuilder<T, TTraits, TScopes, TRelations> {
    const cloned = new EntityBuilder<T, TTraits, TScopes, TRelations>(
      this.tableName,
      { ...this.schema },
      this._traits,
      this._relations,
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
 */
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
