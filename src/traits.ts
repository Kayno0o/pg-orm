import type {
  AfterCreateHook,
  AfterDeleteHook,
  AfterUpdateHook,
  AnyRepository,
  BeforeCreateHook,
  BeforeDeleteHook,
  BeforeUpdateHook,
  EntityHooks,
  EntitySchema,
  FieldConfig,
  TraitDefinition,
  TraitMethod,
  TraitMethods,
} from './types'
import { field } from './field'

// eslint-disable-next-line ts/consistent-type-definitions
type EmptySchema = {}

// eslint-disable-next-line ts/consistent-type-definitions
type EmptyMethods = {}

/**
 * Builder for defining reusable entity traits.
 * Allows composing fields, methods, and hooks.
 */
export class TraitBuilder<
  TFields extends EntitySchema = EmptySchema,
  TMethods extends TraitMethods = EmptyMethods,
> {
  private _fields: TFields
  private _methods: TMethods
  private _hooks: Partial<EntityHooks<TFields>>

  constructor(
    fields: TFields = {} as TFields,
    methods: TMethods = {} as TMethods,
    hooks: Partial<EntityHooks<TFields>> = {},
  ) {
    this._fields = fields
    this._methods = methods
    this._hooks = hooks
  }

  /**
   * Adds a field to the trait.
   * @param name - The name of the field.
   * @param fieldBuilder - The field builder instance.
   */
  field<K extends string, F extends { toConfig: () => FieldConfig }>(
    name: K,
    fieldBuilder: F,
  ): TraitBuilder<TFields & Record<K, ReturnType<F['toConfig']>>, TMethods> {
    const newFields = {
      ...this._fields,
      [name]: fieldBuilder.toConfig(),
    } as TFields & Record<K, ReturnType<F['toConfig']>>

    return new TraitBuilder(newFields, this._methods, this._hooks as any)
  }

  /**
   * Adds multiple fields to the trait.
   * @param fieldsObj - Object mapping field names to field builders.
   */
  fields<T extends Record<string, { toConfig: () => FieldConfig }>>(
    fieldsObj: T,
  ): TraitBuilder<
    TFields & { [K in keyof T]: ReturnType<T[K]['toConfig']> },
    TMethods
  > {
    const newFields = { ...this._fields } as any

    for (const [key, builder] of Object.entries(fieldsObj)) {
      newFields[key] = builder.toConfig()
    }

    return new TraitBuilder(newFields, this._methods, this._hooks as any)
  }

  /**
   * Adds a custom method to the trait.
   * @param name - The name of the method.
   * @param method - The function implementation.
   */
  method<K extends string, M extends TraitMethod>(
    name: K,
    method: M,
  ): TraitBuilder<TFields, TMethods & Record<K, M>> {
    const newMethods = {
      ...this._methods,
      [name]: method,
    } as TMethods & Record<K, M>

    return new TraitBuilder(this._fields, newMethods, this._hooks)
  }

  /**
   * Adds multiple custom methods to the trait.
   * @param methodsObj - Object mapping method names to implementations.
   */
  methods<T extends Record<string, TraitMethod>>(
    methodsObj: T,
  ): TraitBuilder<TFields, TMethods & T> {
    const newMethods = { ...this._methods, ...methodsObj } as TMethods & T

    return new TraitBuilder(this._fields, newMethods, this._hooks)
  }

  /** Registers a beforeCreate hook. */
  beforeCreate(hook: BeforeCreateHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.beforeCreate = [...(newHooks.beforeCreate || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  /** Registers an afterCreate hook. */
  afterCreate(hook: AfterCreateHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.afterCreate = [...(newHooks.afterCreate || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  /** Registers a beforeUpdate hook. */
  beforeUpdate(hook: BeforeUpdateHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.beforeUpdate = [...(newHooks.beforeUpdate || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  /** Registers an afterUpdate hook. */
  afterUpdate(hook: AfterUpdateHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.afterUpdate = [...(newHooks.afterUpdate || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  /** Registers a beforeDelete hook. */
  beforeDelete(hook: BeforeDeleteHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.beforeDelete = [...(newHooks.beforeDelete || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  /** Registers an afterDelete hook. */
  afterDelete(hook: AfterDeleteHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.afterDelete = [...(newHooks.afterDelete || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  /**
   * Merges another trait into this one.
   * @param trait - The trait to merge.
   */
  merge<
    TNewFields extends EntitySchema,
    TNewMethods extends TraitMethods,
  >(
    trait: TraitDefinition<TNewFields, TNewMethods>,
  ): TraitBuilder<
    TFields & TNewFields,
    TMethods & TNewMethods
  > {
    const newFields = { ...this._fields, ...trait.fields } as TFields & TNewFields
    const newMethods = { ...this._methods, ...trait.methods } as TMethods & TNewMethods

    const newHooks = { ...this._hooks } as any

    if (trait.hooks) {
      for (const [hookName, hookArray] of Object.entries(trait.hooks)) {
        if (Array.isArray(hookArray)) {
          newHooks[hookName] = [...(newHooks[hookName] || []), ...hookArray]
        }
      }
    }

    return new TraitBuilder(newFields, newMethods, newHooks)
  }

  /**
   * Finalizes the trait definition.
   */
  build(): TraitDefinition<TFields, TMethods> {
    return Object.freeze({
      fields: this._fields,
      methods: this._methods,
      hooks: Object.keys(this._hooks).length > 0 ? this._hooks : undefined,
    })
  }
}

/** Creates a new trait builder. */
export function createTrait(): TraitBuilder<EmptySchema, EmptyMethods> {
  return new TraitBuilder()
}

/**
 * Adds `createdAt` and `updatedAt` timestamp fields.
 * Automatically manages these fields via hooks.
 */
export function timestamps() {
  return createTrait()
    .fields({
      createdAt: field.timestamp().default('NOW()'),
      updatedAt: field.timestamp().default('NOW()'),
    })
    .beforeCreate((data: any) => {
      const now = new Date()

      data.createdAt ||= now
      data.updatedAt ||= now
    })
    .beforeUpdate((_id: number, data: any) => {
      data.updatedAt = new Date()
    })
    .build()
}

/**
 * Adds soft delete functionality.
 * Includes `deletedAt` field and methods: `softDelete`, `restore`, `isDeleted`.
 */
export function softDelete() {
  return createTrait()
    .field('deletedAt', field.timestamp().nullable())
    .method('softDelete', async function (repo: AnyRepository) {
      return repo.update(this.id, { deletedAt: new Date() })
    })
    .method('restore', async function (repo: AnyRepository) {
      return repo.update(this.id, { deletedAt: null })
    })
    .method('isDeleted', function (_repo: AnyRepository) {
      return this.deletedAt !== null
    })
    .build()
}

/**
 * Combines `timestamps` and `softDelete` traits.
 */
export function paranoid() {
  return createTrait()
    .merge(timestamps())
    .merge(softDelete())
    .build()
}

/**
 * Adds a unique UUID primary key field (named `uuid`).
 * @note This does not replace the standard `id` primary key.
 */
export function uuidPrimary() {
  return createTrait()
    .field('uuid', field.uuid().unique())
    .build()
}

/**
 * Adds a slug field and methods to generate and update it.
 */
export function sluggable() {
  return createTrait()
    .field('slug', field.string().unique())
    .method('generateSlug', (_repo: AnyRepository, source: string): string => {
      return source
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    })
    .method('updateSlug', async function (repo: AnyRepository, source: string) {
      const slug = this.generateSlug(repo, source)

      return repo.update(this.id, { slug })
    })
    .build()
}

/**
 * Adds publishing functionality.
 * Includes `published`, `publishedAt` fields and methods like `publish`, `unpublish`.
 */
export function publishable() {
  return createTrait()
    .fields({
      published: field.boolean().default(false),
      publishedAt: field.timestamp().nullable(),
    })
    .methods({
      async publish(repo: AnyRepository) {
        return repo.update(this.id, {
          published: true,
          publishedAt: new Date(),
        })
      },
      async unpublish(repo: AnyRepository) {
        return repo.update(this.id, {
          published: false,
          publishedAt: null,
        })
      },
      isPublished(_repo: AnyRepository): boolean {
        return this.published === true
      },
      isDraft(_repo: AnyRepository): boolean {
        return this.published === false
      },
    })
    .build()
}

/**
 * Adds sorting capability.
 * Includes `position` field and methods to move items up/down.
 */
export function sortable() {
  return createTrait()
    .field('position', field.number().integer().default(0))
    .method('moveUp', async function (repo: AnyRepository) {
      return repo.update(this.id, { position: this.position - 1 })
    })
    .method('moveDown', async function (repo: AnyRepository) {
      return repo.update(this.id, { position: this.position + 1 })
    })
    .method('moveTo', async function (repo: AnyRepository, position: number) {
      return repo.update(this.id, { position })
    })
    .build()
}

/**
 * Adds optimistic concurrency control via versioning.
 * Includes `version` field and methods to increment it.
 */
export function versionable() {
  return createTrait()
    .field('version', field.number().integer().default(1))
    .method('incrementVersion', function (_repo: AnyRepository): number {
      return (this.version || 1) + 1
    })
    .method('bumpVersion', async function (repo: AnyRepository) {
      const newVersion = this.incrementVersion(repo)

      return repo.update(this.id, { version: newVersion })
    })
    .build()
}
