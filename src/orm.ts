import type { SQL } from 'bun'
import type { CacheAdapter } from './cache'
import type { DatabaseConfig } from './db'
import type { QueryLoggingConfig } from './logger'
import type { RelationSchema } from './relations/types'
import type { EntityDefinition, EntitySchema, FieldConfig } from './types'
import { closeDatabase, initializeDatabase } from './db'
import { createEntitySchema, EntityBuilder } from './entity'
import { field } from './field'
import { queryLogger } from './logger'
import { Migrator } from './migration/migrator'
import { Repository } from './repository'
import { SeederRunner } from './seeder'
import { createTrait } from './traits'

export interface ORMConfig {
  cache?: CacheAdapter
  logging?: QueryLoggingConfig
}

/**
 * Main entry point for the ORM.
 * Manages database connections, entity definitions, and repositories.
 */
export class ORM {
  private repositories = new WeakMap<EntityDefinition<any>, Repository<any>>()
  private entities = new Map<string, EntityDefinition<any>>()
  private migrator: Migrator | null = null
  private migrationConfig: DatabaseConfig['migrations'] | undefined
  private cacheAdapter?: CacheAdapter
  private db: SQL | null = null
  private schema = 'public'

  constructor(config?: ORMConfig) {
    if (config?.cache) {
      this.cacheAdapter = config.cache
    }

    if (config?.logging) {
      queryLogger.configure(config.logging)
    }
  }

  /**
   * Clears all registered entities and repositories.
   * Use this for testing isolation to reset the ORM state.
   */
  clearEntities(): void {
    this.entities.clear()
    this.repositories = new WeakMap()
  }

  /**
   * Connects to the database.
   * @param connectionString - Connection string or configuration object.
   */
  async connect(connectionString: string | DatabaseConfig): Promise<void> {
    // Store database instance per ORM
    this.db = await initializeDatabase(connectionString)

    if (typeof connectionString === 'object') {
      this.migrationConfig = connectionString.migrations

      // Extract schema configuration
      if (connectionString.schema) {
        this.schema = connectionString.schema
        // Schema is set at connection level via options parameter
      }
    }

    if (this.migrationConfig?.autoMigrate === true) {
      await this.ensureMigrator()
    }
  }

  private async ensureMigrator(): Promise<void> {
    if (!this.migrator) {
      const db = this.getDB()

      this.migrator = new Migrator(db, this.entities, this.migrationConfig, this.schema)
      await this.migrator.initialize()
    }
  }

  /**
   * Closes the database connection.
   * @param options - Optional configuration object.
   * @param options.timeout - The maximum time in milliseconds to wait for connections to close.
   */
  async disconnect(options?: { timeout?: number }): Promise<void> {
    if (this.migrator) {
      try {
        await this.migrator.clearAutoMigrations()
      }
      catch (error) {
        // Ignore cleanup errors.
      }
    }

    this.migrator = null

    await closeDatabase(options)

    // Clear instance database reference
    this.db = null
  }

  /**
   * Returns the underlying Bun SQL instance.
   */
  getDB(): SQL {
    if (!this.db) {
      throw new Error('Database not connected. Call connect() first.')
    }

    return this.db
  }

  /**
   * Returns the current PostgreSQL schema being used.
   */
  getSchema(): string {
    return this.schema
  }

  /**
   * Executes a callback within a database transaction.
   * @param callback - Function to execute within the transaction.
   */
  async transaction<T>(callback: (tx: SQL) => Promise<T>): Promise<T> {
    const db = this.getDB()

    return await db.begin(callback)
  }

  /**
   * Registers an entity definition in the global registry.
   * @param entity - The entity definition to register.
   */
  registerEntity(entity: EntityDefinition<any>): void {
    this.entities.set(entity.tableName, entity)
  }

  /**
   * Retrieves an entity definition by table name.
   * @param tableName - The name of the table.
   */
  getEntityByTable(tableName: string): EntityDefinition<any> | undefined {
    return this.entities.get(tableName)
  }

  /**
   * Defines a new entity.
   * @param tableName - The name of the database table.
   * @param fieldsCallback - A callback that receives field builders and returns the schema definition.
   */
  entity<T extends Record<string, { toConfig: () => FieldConfig }>>(
    tableName: string,
    fieldsCallback: (fieldBuilder: typeof field) => T,
  ): EntityBuilder<{
    [K in keyof T]: ReturnType<T[K]['toConfig']>

  }, readonly [], never, {}> {
    const fields = fieldsCallback(field)
    const schema = createEntitySchema(fields)

    return new EntityBuilder(tableName, schema, [], {}, this)
  }

  /**
   * Retrieves or creates a repository for the given entity.
   * @param entityDef - The entity definition.
   */

  repo<T extends EntitySchema, TTraits extends readonly any[] = readonly any[], TScopes extends string = string, TRelations extends RelationSchema = {}>(
    entityDef: EntityDefinition<T, TTraits, TScopes, TRelations>,
  ): Repository<T, TTraits, TScopes, TRelations> {
    if (!this.entities.has(entityDef.tableName)) {
      this.entities.set(entityDef.tableName, entityDef)
    }

    if (this.repositories.has(entityDef)) {
      return this.repositories.get(entityDef)! as Repository<T, TTraits, TScopes, TRelations>
    }

    const repository = new Repository(entityDef, this.cacheAdapter, this)

    this.repositories.set(entityDef, repository as any)

    return repository
  }

  /**
   * Creates a new trait definition.
   */
  trait() {
    return createTrait()
  }

  /** Migration management utilities. */
  get migration() {
    return {
      create: async (name: string) => {
        await this.ensureMigrator()

        return this.migrator!.create(name)
      },

      run: async () => {
        await this.ensureMigrator()

        return this.migrator!.run()
      },

      rollback: async () => {
        await this.ensureMigrator()

        return this.migrator!.rollback()
      },

      reset: async () => {
        await this.ensureMigrator()

        return this.migrator!.reset()
      },

      status: async () => {
        await this.ensureMigrator()

        return this.migrator!.status()
      },

      generate: async (name?: string) => {
        await this.ensureMigrator()

        return this.migrator!.generate(name)
      },
    }
  }

  /**
   * Creates a seeder runner for running database seeds.
   * @param seedsPath - Path to the seeds directory (default: 'seeds').
   */
  seeder(seedsPath = 'seeds'): SeederRunner {
    return new SeederRunner(this, seedsPath)
  }
}
