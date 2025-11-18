import type { SQL } from 'bun'
import type { DatabaseConfig } from './db'
import type { EntityDefinition, EntitySchema, FieldConfig, Plugin } from './types'
import { closeDatabase, getDatabase, initializeDatabase, transaction } from './db'
import { createEntitySchema, EntityBuilder } from './entity'
import { field } from './field'
import { Migrator } from './migration/migrator'
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
  // Track all registered entities for migrations
  private entities = new Map<string, EntityDefinition<any>>()
  // Migration system
  private migrator: Migrator | null = null

  // ========================================================================
  // Database Connection
  // ========================================================================

  async connect(connectionString: string | DatabaseConfig): Promise<void> {
    await initializeDatabase(connectionString)

    // Initialize migrations if configured
    const migrationConfig = typeof connectionString === 'object'
      ? connectionString.migrations
      : undefined

    if (migrationConfig || this.entities.size > 0) {
      const db = getDatabase()

      this.migrator = new Migrator(db, this.entities, migrationConfig)
      await this.migrator.initialize()
    }
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
    // Track entity for migrations
    if (!this.entities.has(entityDef.tableName)) {
      this.entities.set(entityDef.tableName, entityDef)
    }

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

  // ========================================================================
  // Migration API
  // ========================================================================

  /**
   * Migration API - only available after connect()
   */
  get migration() {
    if (!this.migrator) {
      throw new Error('Migrations not initialized. Call orm.connect() first.')
    }

    return {
      /**
       * Create a new migration file
       */
      create: (name: string) => this.migrator!.create(name),

      /**
       * Run all pending migrations
       */
      run: () => this.migrator!.run(),

      /**
       * Rollback the last batch of migrations
       */
      rollback: () => this.migrator!.rollback(),

      /**
       * Rollback all migrations
       */
      reset: () => this.migrator!.reset(),

      /**
       * Show migration status
       */
      status: () => this.migrator!.status(),

      /**
       * Generate migration file from current schema diff
       */
      generate: (name?: string) => this.migrator!.generate(name),
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const orm = new ORM()
