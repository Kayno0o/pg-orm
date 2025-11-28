import type { SQL } from 'bun'
import type {
  Migration,
  MigrationConfig,
  MigrationRecord,
  MigrationRunResult,
  MigrationStatus,
} from './types'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// ============================================================================
// Migration Runner - Execute and Track Migrations
// ============================================================================

export class MigrationRunner {
  constructor(
    private db: SQL,
    private config: Required<MigrationConfig>,
  ) {}

  /** Ensure migrations table exists */
  async ensureMigrationsTable(): Promise<void> {
    const tableName = this.config.migrationsTable

    await this.db`
      CREATE TABLE IF NOT EXISTS ${this.db(tableName)} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        batch INTEGER NOT NULL
      )
    `
  }

  /** Run all pending migrations */
  async run(): Promise<MigrationRunResult> {
    const pending = await this.getPendingMigrations()

    if (pending.length === 0) {
      return {
        executed: [],
        failed: [],
        skipped: [],
      }
    }

    const nextBatch = await this.getNextBatch()
    const executed: string[] = []
    const failed: string[] = []

    for (const migration of pending) {
      try {
        // Execute migration in a transaction
        await this.db.begin(async (tx) => {
          await migration.up(tx)

          // Record migration
          await tx`
            INSERT INTO ${tx(this.config.migrationsTable)} (name, batch)
            VALUES (${migration.name}, ${nextBatch})
          `
        })

        executed.push(migration.name)
      }
      catch (error) {
        console.error(`Failed to execute migration ${migration.name}:`, error)
        failed.push(migration.name)

        // Stop on first failure
        break
      }
    }

    return {
      executed,
      failed,
      skipped: [],
    }
  }

  /** Rollback the last batch of migrations */
  async rollback(): Promise<MigrationRunResult> {
    const lastBatch = await this.getLastBatch()

    if (!lastBatch) {
      return {
        executed: [],
        failed: [],
        skipped: [],
      }
    }

    const migrations = await this.getMigrationsByBatch(lastBatch)
    const allMigrations = await this.loadMigrations()
    const executed: string[] = []
    const failed: string[] = []

    // Rollback in reverse order
    for (const record of migrations.reverse()) {
      const migration = allMigrations.find(m => m.name === record.name)

      if (!migration) {
        console.warn(`Migration file not found for ${record.name}`)
        failed.push(record.name)

        continue
      }

      try {
        // Execute rollback in a transaction
        await this.db.begin(async (tx) => {
          await migration.down(tx)

          // Remove migration record
          await tx`
            DELETE FROM ${tx(this.config.migrationsTable)}
            WHERE name = ${migration.name}
          `
        })

        executed.push(migration.name)
      }
      catch (error) {
        console.error(`Failed to rollback migration ${migration.name}:`, error)
        failed.push(migration.name)

        // Stop on first failure
        break
      }
    }

    return {
      executed,
      failed,
      skipped: [],
    }
  }

  /** Rollback all migrations */
  async reset(): Promise<MigrationRunResult> {
    const executed: string[] = []
    const failed: string[] = []

    let hasMoreBatches = true

    while (hasMoreBatches) {
      const result = await this.rollback()

      executed.push(...result.executed)
      failed.push(...result.failed)

      if (result.failed.length > 0 || result.executed.length === 0) {
        hasMoreBatches = false
      }
    }

    return {
      executed,
      failed,
      skipped: [],
    }
  }

  /** Get migration status (pending and executed) */
  async status(): Promise<MigrationStatus> {
    const allMigrations = await this.loadMigrations()
    const executed = await this.getExecutedMigrations()
    const executedNames = new Set(executed.map(m => m.name))

    const pending = allMigrations
      .filter(m => !executedNames.has(m.name))
      .map(m => m.name)

    return {
      pending,
      executed,
      total: allMigrations.length,
      pendingCount: pending.length,
      executedCount: executed.length,
    }
  }

  // ========================================================================
  // Migration Loading
  // ========================================================================

  /** Load all migration files from directory */
  private async loadMigrations(): Promise<Migration[]> {
    const migrationsPath = this.config.migrationsPath

    try {
      const files = await readdir(migrationsPath)
      const migrationFiles = files
        .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
        .sort()

      const migrations: Migration[] = []

      for (const file of migrationFiles) {
        const filePath = resolve(migrationsPath, file)

        try {
          const module = await import(filePath)
          const migration = module.migration || module.default

          if (!migration) {
            throw new Error(`Migration file ${file} does not export 'migration' or 'default'`)
          }

          if (typeof migration.up !== 'function') {
            throw new TypeError(`Migration file ${file} is missing 'up()' function`)
          }

          if (typeof migration.down !== 'function') {
            throw new TypeError(`Migration file ${file} is missing 'down()' function`)
          }

          if (!migration.name || typeof migration.name !== 'string') {
            throw new Error(`Migration file ${file} is missing 'name' property`)
          }

          migrations.push(migration)
        }
        catch (error) {
          throw new Error(`Failed to load migration ${file}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      return migrations
    }
    catch (error) {
      // Directory doesn't exist or is empty
      return []
    }
  }

  /** Get pending migrations (not yet executed) */
  private async getPendingMigrations(): Promise<Migration[]> {
    const allMigrations = await this.loadMigrations()
    const executed = await this.getExecutedMigrations()
    const executedNames = new Set(executed.map(m => m.name))

    return allMigrations.filter(m => !executedNames.has(m.name))
  }

  // ========================================================================
  // Migration Tracking
  // ========================================================================

  /** Get all executed migrations */
  private async getExecutedMigrations(): Promise<MigrationRecord[]> {
    const results = await this.db`
      SELECT
        id,
        name,
        executed_at as "executedAt",
        batch
      FROM ${this.db(this.config.migrationsTable)}
      ORDER BY id ASC
    `

    return results.map((row: any) => ({
      id: row.id,
      name: row.name,
      executed_at: row.executedAt,
      batch: row.batch,
    }))
  }

  /** Get migrations from a specific batch */
  private async getMigrationsByBatch(batch: number): Promise<MigrationRecord[]> {
    const results = await this.db`
      SELECT
        id,
        name,
        executed_at as "executedAt",
        batch
      FROM ${this.db(this.config.migrationsTable)}
      WHERE batch = ${batch}
      ORDER BY id ASC
    `

    return results.map((row: any) => ({
      id: row.id,
      name: row.name,
      executed_at: row.executedAt,
      batch: row.batch,
    }))
  }

  /** Get the last batch number */
  private async getLastBatch(): Promise<number | null> {
    const [result] = await this.db`
      SELECT MAX(batch) as batch
      FROM ${this.db(this.config.migrationsTable)}
    `

    return result?.batch || null
  }

  /** Get the next batch number */
  private async getNextBatch(): Promise<number> {
    const lastBatch = await this.getLastBatch()

    return (lastBatch || 0) + 1
  }
}
