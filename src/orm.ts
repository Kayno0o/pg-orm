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
  private migrationConfig: DatabaseConfig['migrations'] | undefined

  // ========================================================================
  // Database Connection
  // ========================================================================

  async connect(connectionString: string | DatabaseConfig): Promise<void> {
    await initializeDatabase(connectionString)

    // Store migration config for lazy initialization
    this.migrationConfig = typeof connectionString === 'object'
      ? connectionString.migrations
      : undefined

    // Initialize migrator to run auto-migrations
    await this.ensureMigrator()
  }

  /**
   * Lazy initialize migrator when first accessed
   * This ensures all entities are registered before migration detection
   */
  private async ensureMigrator(): Promise<void> {
    if (!this.migrator) {
      const db = getDatabase()

      this.migrator = new Migrator(db, this.entities, this.migrationConfig)
      await this.migrator.initialize()
    }
  }

  async disconnect(options?: { timeout?: number }): Promise<void> {
    // Cleanup all repositories
    for (const repo of this.allRepositories) {
      repo.cleanup()
    }
    this.allRepositories.clear()

    // Clear auto-migration tracking for fresh start on reconnect
    if (this.migrator) {
      try {
        await this.migrator.clearAutoMigrations()
      }
      catch (error) {
        // Ignore errors during cleanup (database might be closing)
      }
    }

    // Reset migrator to allow fresh initialization on reconnect
    this.migrator = null

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

  trait() {
    return createTrait()
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
    return {
      /**
       * Create a new migration file
       */
      create: async (name: string) => {
        await this.ensureMigrator()

        return this.migrator!.create(name)
      },

      /**
       * Run all pending migrations
       */
      run: async () => {
        await this.ensureMigrator()

        return this.migrator!.run()
      },

      /**
       * Rollback the last batch of migrations
       */
      rollback: async () => {
        await this.ensureMigrator()

        return this.migrator!.rollback()
      },

      /**
       * Rollback all migrations
       */
      reset: async () => {
        await this.ensureMigrator()

        return this.migrator!.reset()
      },

      /**
       * Show migration status
       */
      status: async () => {
        await this.ensureMigrator()

        return this.migrator!.status()
      },

      /**
       * Generate migration file from current schema diff
       */
      generate: async (name?: string) => {
        await this.ensureMigrator()

        return this.migrator!.generate(name)
      },
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const orm = new ORM()
