import type { SQL } from 'bun'
import type { DatabaseConfig } from './db'
import type { EntityDefinition, EntitySchema, FieldConfig } from './types'
import { closeDatabase, getDatabase, initializeDatabase, transaction } from './db'
import { createEntitySchema, EntityBuilder } from './entity'
import { field } from './field'
import { Migrator } from './migration/migrator'
import { Repository } from './repository'
import { createTrait } from './traits'

export class ORM {
  private repositories = new WeakMap<EntityDefinition<any>, Repository<any>>()
  private allRepositories = new Set<Repository<any>>()
  private entities = new Map<string, EntityDefinition<any>>()
  private migrator: Migrator | null = null
  private migrationConfig: DatabaseConfig['migrations'] | undefined

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

  async disconnect(options?: { timeout?: number }): Promise<void> {
    for (const repo of this.allRepositories) {
      repo.cleanup()
    }
    this.allRepositories.clear()

    if (this.migrator) {
      try {
        await this.migrator.clearAutoMigrations()
      }
      catch (error) {
        // Ignore errors during cleanup
      }
    }

    this.migrator = null

    await closeDatabase(options)
  }

  getDB(): SQL {
    return getDatabase()
  }

  async transaction<T>(callback: (tx: SQL) => Promise<T>): Promise<T> {
    return transaction(callback)
  }

  entity<T extends Record<string, { toConfig: () => FieldConfig }>>(
    tableName: string,
    fields: T,
  ): EntityBuilder<{
    [K in keyof T]: ReturnType<T[K]['toConfig']>
  }> {
    const schema = createEntitySchema(fields)

    return new EntityBuilder(tableName, schema)
  }

  repo<T extends EntitySchema, TTraits extends readonly any[] = readonly any[]>(
    entityDef: EntityDefinition<T, TTraits>,
  ): Repository<T, TTraits> {
    if (!this.entities.has(entityDef.tableName)) {
      this.entities.set(entityDef.tableName, entityDef)
    }

    if (this.repositories.has(entityDef)) {
      return this.repositories.get(entityDef)! as Repository<T, TTraits>
    }

    const repository = new Repository(entityDef)

    this.repositories.set(entityDef, repository)
    this.allRepositories.add(repository)

    return repository
  }

  trait() {
    return createTrait()
  }

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
