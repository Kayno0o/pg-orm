import type { AnyRepository, EntitySchema, FieldConfig, TraitDefinition, TraitMethod, TraitMethods } from './types'
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

  constructor(
    private readonly name: string,
    fields: TFields = {} as TFields,
    methods: TMethods = {} as TMethods,
  ) {
    this._fields = fields
    this._methods = methods
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

    return new TraitBuilder(this.name, newFields, this._methods)
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

    return new TraitBuilder(this.name, newFields, this._methods)
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

    return new TraitBuilder(this.name, this._fields, newMethods)
  }

  // Convenience method to add multiple methods at once
  methods<T extends Record<string, TraitMethod>>(
    methodsObj: T,
  ): TraitBuilder<TFields, TMethods & T> {
    const newMethods = { ...this._methods, ...methodsObj } as TMethods & T

    return new TraitBuilder(this.name, this._fields, newMethods)
  }

  // ========================================================================
  // Build Final Trait Definition
  // ========================================================================

  build(): TraitDefinition<TFields, TMethods> {
    return Object.freeze({
      name: this.name,
      fields: this._fields,
      methods: this._methods,
    })
  }
}

// ============================================================================
// Trait Factory Function
// ============================================================================

export function createTrait(name: string): TraitBuilder<EmptySchema, EmptyMethods> {
  return new TraitBuilder(name)
}

// ============================================================================
// Built-in Traits
// ============================================================================

/**
 * Timestamps trait - adds createdAt and updatedAt fields
 */
export function timestamps() {
  return createTrait('timestamps').fields({
    createdAt: field.timestamp().default('NOW()'),
    updatedAt: field.timestamp().default('NOW()'),
  }).build()
}

/**
 * Soft delete trait - adds deletedAt field and soft delete methods
 */
export function softDelete() {
  return createTrait('softDelete')
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
 * Paranoid trait - combines timestamps and soft delete
 */
export function paranoid() {
  return createTrait('paranoid')
    .fields({
      createdAt: field.timestamp().default('NOW()'),
      updatedAt: field.timestamp().default('NOW()'),
      deletedAt: field.timestamp().nullable(),
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
  return createTrait('uuidPrimary')
    .field('uuid', field.uuid().unique())
    .build()
}

/**
 * Sluggable trait - adds slug field and slug generation method
 */
export function sluggable() {
  return createTrait('sluggable')
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
  return createTrait('publishable')
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
  return createTrait('sortable')
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
  return createTrait('versionable')
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
