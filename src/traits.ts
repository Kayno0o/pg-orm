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

// ============================================================================
// Empty Types (to avoid index signature issues)
// ============================================================================

// eslint-disable-next-line ts/consistent-type-definitions, ts/no-empty-object-type
type EmptySchema = {}

// eslint-disable-next-line ts/consistent-type-definitions, ts/no-empty-object-type
type EmptyMethods = {}

// ============================================================================
// Trait Builder
// ============================================================================

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

  // ========================================================================
  // Add Fields
  // ========================================================================

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

  // Convenience method to add multiple fields at once
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

  // ========================================================================
  // Add Methods
  // ========================================================================

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

  // Convenience method to add multiple methods at once
  methods<T extends Record<string, TraitMethod>>(
    methodsObj: T,
  ): TraitBuilder<TFields, TMethods & T> {
    const newMethods = { ...this._methods, ...methodsObj } as TMethods & T

    return new TraitBuilder(this._fields, newMethods, this._hooks)
  }

  // ========================================================================
  // Add Hooks
  // ========================================================================

  beforeCreate(hook: BeforeCreateHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.beforeCreate = [...(newHooks.beforeCreate || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  afterCreate(hook: AfterCreateHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.afterCreate = [...(newHooks.afterCreate || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  beforeUpdate(hook: BeforeUpdateHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.beforeUpdate = [...(newHooks.beforeUpdate || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  afterUpdate(hook: AfterUpdateHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.afterUpdate = [...(newHooks.afterUpdate || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  beforeDelete(hook: BeforeDeleteHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.beforeDelete = [...(newHooks.beforeDelete || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  afterDelete(hook: AfterDeleteHook<TFields>): TraitBuilder<TFields, TMethods> {
    const newHooks = { ...this._hooks }

    newHooks.afterDelete = [...(newHooks.afterDelete || []), hook]

    return new TraitBuilder(this._fields, this._methods, newHooks)
  }

  // ========================================================================
  // Build Final Trait Definition
  // ========================================================================

  build(): TraitDefinition<TFields, TMethods> {
    return Object.freeze({
      fields: this._fields,
      methods: this._methods,
      hooks: Object.keys(this._hooks).length > 0 ? this._hooks : undefined,
    })
  }
}

// ============================================================================
// Trait Factory Function
// ============================================================================

export function createTrait(): TraitBuilder<EmptySchema, EmptyMethods> {
  return new TraitBuilder()
}

// ============================================================================
// Built-in Traits
// ============================================================================

/**
 * Timestamps trait - adds createdAt and updatedAt fields with automatic updates
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
 * Soft delete trait - adds deletedAt field and soft delete methods
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
 * Paranoid trait - combines timestamps and soft delete with automatic updates
 */
export function paranoid() {
  return createTrait()
    .fields({
      createdAt: field.timestamp().default('NOW()'),
      updatedAt: field.timestamp().default('NOW()'),
      deletedAt: field.timestamp().nullable(),
    })
    .beforeCreate((data: any) => {
      const now = new Date()

      data.createdAt ||= now
      data.updatedAt ||= now
    })
    .beforeUpdate((_id: number, data: any) => {
      data.updatedAt = new Date()
    })
    .methods({
      async softDelete(repo: AnyRepository) {
        return repo.update(this.id, { deletedAt: new Date() })
      },
      async restore(repo: AnyRepository) {
        return repo.update(this.id, { deletedAt: null })
      },
      isDeleted(_repo: AnyRepository) {
        return this.deletedAt !== null
      },
    })
    .build()
}

/**
 * UUID primary key trait - adds uuid field
 */
export function uuidPrimary() {
  return createTrait()
    .field('uuid', field.uuid().unique())
    .build()
}

/**
 * Sluggable trait - adds slug field and slug generation method
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
 * Publishable trait - adds published field and publishing methods
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
 * Sortable trait - adds position field for ordering
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
 * Versionable trait - adds version field for optimistic locking
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
