import type { SQL } from 'bun'
import type { EntityDefinition, EntitySchema, FieldConfig, Plugin } from './types'
import { closeDatabase, getDatabase, initializeDatabase, transaction } from './db'
import { createEntitySchema, EntityBuilder } from './entity'
import { field } from './field'
import { Repository } from './repository'

// ============================================================================
// ORM Class
// ============================================================================

export class ORM {
  private plugins: Plugin[] = []
  private repositories = new Map<string, Repository<any>>()
  private entities = new Map<string, EntityDefinition<any>>()

  // ========================================================================
  // Database Connection
  // ========================================================================

  async connect(connectionString: string | SQL.Options): Promise<void> {
    await initializeDatabase(connectionString)
  }

  async disconnect(options?: { timeout?: number }): Promise<void> {
    await closeDatabase(options)
    this.repositories.clear()
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

  repo<T extends EntitySchema>(entityDef: EntityDefinition<T>): Repository<T> {
    const key = entityDef.tableName

    // Return cached repository if exists
    if (this.repositories.has(key)) {
      return this.repositories.get(key)!
    }

    // Create new repository
    const repository = new Repository(entityDef)

    this.repositories.set(key, repository)
    this.entities.set(key, entityDef)

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

    // Apply to existing entities
    for (const [_key, _entityDef] of this.entities) {
      if (plugin.applyToEntity) {
        // plugin.applyToEntity(entityDef)
      }
    }

    // Apply to existing repositories
    for (const [_key, repository] of this.repositories) {
      if (plugin.applyToRepository) {
        plugin.applyToRepository(repository)
      }
    }

    return this
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
