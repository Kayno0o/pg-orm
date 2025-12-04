import type { SQL } from 'bun'
import type { CacheAdapter } from './cache'
import type { DatabaseConfig } from './db'
import type { EntityDefinition, EntitySchema, FieldConfig } from './types'
import { closeDatabase, getDatabase, initializeDatabase, transaction } from './db'
import { createEntitySchema, EntityBuilder } from './entity'
import { field } from './field'
import { Migrator } from './migration/migrator'
import { Repository } from './repository'
import { createTrait } from './traits'

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

  /**
   * Connects to the database.
   * @param connectionString - Connection string or configuration object.
   */
  async connect(connectionString: string | DatabaseConfig): Promise<void> {
    await initializeDatabase(connectionString)

    this.migrationConfig = typeof connectionString === 'object'
      ? connectionString.migrations
      : undefined

    if (this.migrationConfig?.autoMigrate === true) {
      await this.ensureMigrator()
    }
  }

  private async ensureMigrator(): Promise<void> {
    if (!this.migrator) {
      const db = getDatabase()

      this.migrator = new Migrator(db, this.entities, this.migrationConfig)
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
  }

  /**
   * Returns the underlying Bun SQL instance.
   */
  getDB(): SQL {
    return getDatabase()
  }

  /**
   * Executes a callback within a database transaction.
   * @param callback - Function to execute within the transaction.
   */
  async transaction<T>(callback: (tx: SQL) => Promise<T>): Promise<T> {
    return transaction(callback)
  }

  /**
   * Defines a new entity.
   * @param tableName - The name of the database table.
   * @param fields - The schema definition for the entity.
   */
  entity<T extends Record<string, { toConfig: () => FieldConfig }>>(
    tableName: string,
    fields: T,
  ): EntityBuilder<{
    [K in keyof T]: ReturnType<T[K]['toConfig']>
  }> {
    const schema = createEntitySchema(fields)

    return new EntityBuilder(tableName, schema)
  }

  /**
   * Retrieves or creates a repository for the given entity.
   * @param entityDef - The entity definition.
   */
  repo<T extends EntitySchema, TTraits extends readonly any[] = readonly any[], TScopes extends string = string>(
    entityDef: EntityDefinition<T, TTraits, TScopes>,
  ): Repository<T, TTraits, TScopes> {
    if (!this.entities.has(entityDef.tableName)) {
      this.entities.set(entityDef.tableName, entityDef)
    }

    if (this.repositories.has(entityDef)) {
      return this.repositories.get(entityDef)! as Repository<T, TTraits, TScopes>
    }

    const repository = new Repository(entityDef, this.cacheAdapter)

    this.repositories.set(entityDef, repository)

    return repository
  }

  /**
   * Configures a cache adapter for the ORM.
   * @param cacheAdapter - The cache adapter to use.
   */
  useCache(cacheAdapter: CacheAdapter): this {
    this.cacheAdapter = cacheAdapter

    return this
  }

  /**
   * Creates a new trait definition.
   */
  trait() {
    return createTrait()
  }

  /** Field builder for string types. */
  get string() {
    return field.string
  }

  /** Field builder for number types. */
  get number() {
    return field.number
  }

  /** Field builder for boolean types. */
  get boolean() {
    return field.boolean
  }

  /** Field builder for JSON types. */
  get json() {
    return field.json
  }

  /** Field builder for JSONB types. */
  get jsonb() {
    return field.jsonb
  }

  /** Field builder for UUID types. */
  get uuid() {
    return field.uuid
  }

  /** Field builder for timestamp types. */
  get timestamp() {
    return field.timestamp
  }

  /** Field builder for date types. */
  get date() {
    return field.date
  }

  /** Field builder for array types. */
  get array() {
    return field.array
  }

  /** Field builder for enum types. */
  get enum() {
    return field.enum
  }

  /** Field builder for blob types. */
  get blob() {
    return field.blob
  }

  /** Field builder for foreign key references. */
  get foreignKey() {
    return field.foreignKey
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
}

export const orm = new ORM()
