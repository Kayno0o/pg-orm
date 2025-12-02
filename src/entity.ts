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

export class EntityBuilder<
  T extends EntitySchema,
  TTraits extends readonly TraitDefinition<any, any>[] = readonly [],
  TScopes extends string = never,
> {
  private _hooks: EntityHooks<T>
  private _traits: TTraits
  private _unique?: string[][]
  private _scopes: Map<string, ScopeDefinition<T>>

  constructor(
    private readonly tableName: string,
    private readonly schema: T,
    traits: TTraits = [] as any,
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
  }

  beforeCreate(hook: BeforeCreateHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeCreate.push(hook)

    return newBuilder
  }

  afterCreate(hook: AfterCreateHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterCreate.push(hook)

    return newBuilder
  }

  beforeUpdate(hook: BeforeUpdateHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeUpdate.push(hook)

    return newBuilder
  }

  afterUpdate(hook: AfterUpdateHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterUpdate.push(hook)

    return newBuilder
  }

  beforeDelete(hook: BeforeDeleteHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.beforeDelete.push(hook)

    return newBuilder
  }

  afterDelete(hook: AfterDeleteHook<T>): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._hooks.afterDelete.push(hook)

    return newBuilder
  }

  use<TraitFields extends EntitySchema, TraitMethods extends Record<string, any>>(
    trait: TraitDefinition<TraitFields, TraitMethods>,
  ): EntityBuilder<T & TraitFields, readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>], TScopes> {
    const newSchema = { ...this.schema, ...trait.fields } as T & TraitFields
    const newTraits = [...this._traits, trait] as unknown as readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>]
    const newBuilder = new EntityBuilder<T & TraitFields, readonly [...TTraits, TraitDefinition<TraitFields, TraitMethods>], TScopes>(
      this.tableName,
      newSchema,
      newTraits,
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
    newBuilder._scopes = this._scopes

    return newBuilder
  }

  unique(...columns: (keyof T)[][]): EntityBuilder<T, TTraits, TScopes> {
    const newBuilder = this.clone()

    newBuilder._unique = columns.map(cols => cols.map(String))

    return newBuilder
  }

  scope<Name extends string>(name: Name, scopeFn: ScopeDefinition<T>): EntityBuilder<T, TTraits, TScopes | Name> {
    const newBuilder = this.clone()

    newBuilder._scopes.set(name, scopeFn)

    return newBuilder as unknown as EntityBuilder<T, TTraits, TScopes | Name>
  }

  build(): EntityDefinition<T, TTraits, TScopes> {
    return Object.freeze({
      tableName: this.tableName,
      schema: this.schema,
      hooks: this._hooks,
      traits: this._traits,
      unique: this._unique,
      scopes: this._scopes,
    })
  }

  private clone(): EntityBuilder<T, TTraits, TScopes> {
    const cloned = new EntityBuilder<T, TTraits, TScopes>(this.tableName, { ...this.schema }, this._traits)

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
