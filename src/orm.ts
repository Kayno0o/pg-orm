import type { SQL } from 'bun'
import type { CacheAdapter } from './cache'
import type { DatabaseConfig } from './db'
import type { RelationSchema } from './relations/types'
import type { EntityDefinition, EntitySchema, FieldConfig } from './types'
import { closeDatabase, initializeDatabase } from './db'
import { createEntitySchema, EntityBuilder } from './entity'
import { field } from './field'
import { Migrator } from './migration/migrator'
import {
  BelongsToBuilder,
  HasManyBuilder,
  HasOneBuilder,
  ManyToManyBuilder,
} from './relations/builders'
import { Repository } from './repository'
import { SeederRunner } from './seeder'
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
  private db: SQL | null = null
  private schema = 'public'

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
      this.cacheAdapter = connectionString.cache

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
   * @param fields - The schema definition for the entity.
   */
  entity<T extends Record<string, { toConfig: () => FieldConfig }>>(
    tableName: string,
    fields: T,
  ): EntityBuilder<{
    [K in keyof T]: ReturnType<T[K]['toConfig']>

  }, readonly [], never, {}> {
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

    this.repositories.set(entityDef, repository)

    return repository
  }

  /**
   * Defines a hasOne relation.
   * @param tableName - The name of the related table.
   * @param foreignKey - The foreign key field in the related table.
   */
  hasOne(tableName: string, foreignKey: string): HasOneBuilder {
    return new HasOneBuilder(tableName, foreignKey)
  }

  /**
   * Defines a hasMany relation.
   * @param tableName - The name of the related table.
   * @param foreignKey - The foreign key field in the related table.
   */
  hasMany(tableName: string, foreignKey: string): HasManyBuilder {
    return new HasManyBuilder(tableName, foreignKey)
  }

  /**
   * Defines a belongsTo relation.
   * @param tableName - The name of the related table.
   * @param foreignKey - The foreign key field in this table.
   */
  belongsTo(tableName: string, foreignKey: string): BelongsToBuilder {
    return new BelongsToBuilder(tableName, foreignKey)
  }

  /**
   * Defines a manyToMany relation.
   * @param tableName - The name of the related table.
   * @param through - The junction table name.
   * @param throughForeignKey - The foreign key in the junction table for this entity.
   * @param otherKey - The foreign key in the junction table for the related entity.
   */
  manyToMany(
    tableName: string,
    through: string,
    throughForeignKey: string,
    otherKey: string,
  ): ManyToManyBuilder {
    return new ManyToManyBuilder(tableName, through, throughForeignKey, otherKey)
  }

  /**
   * Creates a type-safe relation builder for an entity.
   * Enables full type inference for relations.
   *
   * @example
   * const User = orm.entity('users', { name: orm.string() }).build()
   * const Post = orm.entity('posts', {
   *   title: orm.string(),
   *   authorId: orm.foreignKey('users')
   * }).relations({
   *   author: orm.relation(User).belongsTo('authorId')
   * }).build()
   *
   * // Now loaded.author is fully typed as User | null
   * const loaded = await posts.find(1, { with: ['author'] })
   *
   * @param entity - The related entity definition
   */
  relation<T extends EntitySchema, TTraits extends readonly any[]>(
    entity: EntityDefinition<T, TTraits, any, any>,
  ) {
    return {
      hasOne: (foreignKey: string) =>
        new HasOneBuilder<T, TTraits>(entity.tableName, foreignKey),

      hasMany: (foreignKey: string) =>
        new HasManyBuilder<T, TTraits>(entity.tableName, foreignKey),

      belongsTo: (foreignKey: string) =>
        new BelongsToBuilder<T, TTraits>(entity.tableName, foreignKey),

      manyToMany: (through: string, throughForeignKey: string, otherKey: string) =>
        new ManyToManyBuilder<T, TTraits>(entity.tableName, through, throughForeignKey, otherKey),
    }
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

  /**
   * Creates a seeder runner for running database seeds.
   * @param seedsPath - Path to the seeds directory (default: 'seeds').
   */
  seeder(seedsPath = 'seeds'): SeederRunner {
    return new SeederRunner(this, seedsPath)
  }
}
