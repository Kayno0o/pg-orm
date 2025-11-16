import type { EntitySchema, TraitDefinition } from './types'
import { field } from './field'

// ============================================================================
// Trait Builder
// ============================================================================

export function createTrait<Methods extends Record<string, (this: any, ...args: any[]) => any>>(config: {
  name: string
  fields?: EntitySchema
  methods?: Methods
}): TraitDefinition<Methods> {
  return {
    name: config.name,
    fields: config.fields,
    methods: config.methods,
  }
}

// ============================================================================
// Built-in Traits
// ============================================================================

/**
 * Timestamps trait - adds createdAt and updatedAt fields
 */
export function timestamps() {
  return createTrait({
    name: 'timestamps',
    fields: {
      createdAt: field.timestamp().default('NOW()').toConfig(),
      updatedAt: field.timestamp().default('NOW()').toConfig(),
    },
  })
}

/**
 * Soft delete trait - adds deletedAt field
 */
export function softDelete() {
  return createTrait({
    name: 'softDelete',
    fields: {
      deletedAt: field.timestamp().nullable().toConfig(),
    },
    methods: {
      async softDelete(this: any) {
        // This would be implemented by repository
        // For now, it's a placeholder for the method signature
        console.warn('softDelete method needs repository context')
      },
      async restore(this: any) {
        console.warn('restore method needs repository context')
      },
      isDeleted(this: any): boolean {
        return this.deletedAt !== null
      },
    },
  })
}

/**
 * Paranoid trait - combines timestamps and soft delete
 */
export function paranoid() {
  return createTrait({
    name: 'paranoid',
    fields: {
      createdAt: field.timestamp().default('NOW()').toConfig(),
      updatedAt: field.timestamp().default('NOW()').toConfig(),
      deletedAt: field.timestamp().nullable().toConfig(),
    },
    methods: {
      async softDelete(this: any) {
        console.warn('softDelete method needs repository context')
      },
      async restore(this: any) {
        console.warn('restore method needs repository context')
      },
      isDeleted(this: any): boolean {
        return this.deletedAt !== null
      },
    },
  })
}

/**
 * UUID primary key trait - adds uuid field
 */
export function uuidPrimary() {
  return createTrait({
    name: 'uuidPrimary',
    fields: {
      uuid: field.uuid().unique().toConfig(),
    },
  })
}

/**
 * Sluggable trait - adds slug field
 */
export function sluggable() {
  return createTrait({
    name: 'sluggable',
    fields: {
      slug: field.string().unique().toConfig(),
    },
    methods: {
      generateSlug(this: any, source: string): string {
        return source
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
      },
    },
  })
}

/**
 * Publishable trait - adds published field
 */
export function publishable() {
  return createTrait({
    name: 'publishable',
    fields: {
      published: field.boolean().default(false).toConfig(),
      publishedAt: field.timestamp().nullable().toConfig(),
    },
    methods: {
      isPublished(this: any): boolean {
        return this.published === true
      },
      isDraft(this: any): boolean {
        return this.published === false
      },
    },
  })
}

/**
 * Sortable trait - adds position field for ordering
 */
export function sortable() {
  return createTrait({
    name: 'sortable',
    fields: {
      position: field.number().integer().default(0).toConfig(),
    },
  })
}

/**
 * Versionable trait - adds version field for optimistic locking
 */
export function versionable() {
  return createTrait({
    name: 'versionable',
    fields: {
      version: field.number().integer().default(1).toConfig(),
    },
    methods: {
      incrementVersion(this: any): void {
        this.version = (this.version || 1) + 1
      },
    },
  })
}
