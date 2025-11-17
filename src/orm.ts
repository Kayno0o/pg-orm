import type { SQL } from 'bun'
import type { EntityDefinition, EntitySchema, FieldConfig, Plugin } from './types'
import { closeDatabase, getDatabase, initializeDatabase, transaction, type DatabaseConfig } from './db'
import { createEntitySchema, EntityBuilder } from './entity'
import { field } from './field'
import { Repository } from './repository'
import { createTrait } from './traits'

// ============================================================================
// ORM Class
// ============================================================================

export class ORM {
  private plugins: Plugin[] = []
  // Use WeakMap to prevent stale repository instances when entity definitions change
  private repositories = new WeakMap<EntityDefinition<any>, Repository<any>>()
  // Track all created repositories for cleanup
  private allRepositories = new Set<Repository<any>>()

  // ========================================================================
  // Database Connection
  // ========================================================================

  async connect(connectionString: string | DatabaseConfig): Promise<void> {
    await initializeDatabase(connectionString)
  }

  async disconnect(options?: { timeout?: number }): Promise<void> {
    // Cleanup all repositories
    for (const repo of this.allRepositories) {
      repo.cleanup()
    }
    this.allRepositories.clear()

    await closeDatabase(options)
  }

  getDB(): SQL {
    return getDatabase()
  }

  async transaction<T>(callback: (tx: SQL) => Promise<T>): Promise<T> {
    return transaction(callback)
  }

  // ========================================================================
  // Entity Builder
  // ========================================================================

  entity<T extends Record<string, { toConfig: () => FieldConfig }>>(
    tableName: string,
    fields: T,
  ): EntityBuilder<{
    [K in keyof T]: ReturnType<T[K]['toConfig']>
  }> {
    const schema = createEntitySchema(fields)
    const builder = new EntityBuilder(tableName, schema)

    // Apply global plugins
    for (const plugin of this.plugins) {
      if (plugin.applyToEntity) {
        // plugin.applyToEntity(builder as any)
      }
    }

    return builder
  }

  // ========================================================================
  // Repository Access
  // ========================================================================

  repo<T extends EntitySchema, TTraits extends readonly any[] = readonly any[]>(
    entityDef: EntityDefinition<T, TTraits>,
  ): Repository<T, TTraits> {
    // Return cached repository if exists for this specific entity definition
    if (this.repositories.has(entityDef)) {
      return this.repositories.get(entityDef)! as Repository<T, TTraits>
    }

    // Create new repository
    const repository = new Repository(entityDef)

    this.repositories.set(entityDef, repository)
    this.allRepositories.add(repository)

    // Apply global plugins
    for (const plugin of this.plugins) {
      if (plugin.applyToRepository) {
        plugin.applyToRepository(repository)
      }
    }

    return repository
  }

  // ========================================================================
  // Global Plugins
  // ========================================================================

  use(plugin: Plugin): this {
    this.plugins.push(plugin)

    // Apply to existing repositories
    for (const repository of this.allRepositories) {
      if (plugin.applyToRepository) {
        plugin.applyToRepository(repository)
      }
    }

    return this
  }

  // ========================================================================
  // Trait Builder
  // ========================================================================

  trait(name: string) {
    return createTrait(name)
  }

  // ========================================================================
  // Field Builders (convenience)
  // ========================================================================

  get string() {
    return field.string
  }

  get number() {
    return field.number
  }

  get boolean() {
    return field.boolean
  }

  get json() {
    return field.json
  }

  get jsonb() {
    return field.jsonb
  }

  get uuid() {
    return field.uuid
  }

  get timestamp() {
    return field.timestamp
  }

  get date() {
    return field.date
  }

  get array() {
    return field.array
  }

  get enum() {
    return field.enum
  }

  get blob() {
    return field.blob
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const orm = new ORM()
