import type { SQL } from 'bun'
import type { EntityDefinition } from '../types'
import type { MigrationConfig, SchemaDiff } from './types'
import { MigrationGenerator } from './generator'
import { MigrationRunner } from './runner'
import { SchemaDiffer } from './schema-differ'
import { SchemaInspector } from './schema-inspector'

// ============================================================================
// Migrator - Main Orchestrator for Migrations
// ============================================================================

export class Migrator {
  private inspector: SchemaInspector
  private runner: MigrationRunner
  private generator: MigrationGenerator
  private differ: SchemaDiffer | null = null

  constructor(
    private db: SQL,
    private entities: Map<string, EntityDefinition<any>>,
    private config: MigrationConfig = {},
  ) {
    // Apply defaults
    const fullConfig: Required<MigrationConfig> = {
      autoMigrate: config.autoMigrate ?? true,
      noInteraction: config.noInteraction ?? false,
      killIfUpdate: config.killIfUpdate ?? true,
      safeMigrations: config.safeMigrations ?? true,
      migrationsPath: config.migrationsPath ?? 'migrations',
      migrationsTable: config.migrationsTable ?? '_migrations',
    }

    this.inspector = new SchemaInspector(db)
    this.runner = new MigrationRunner(db, fullConfig)
    this.generator = new MigrationGenerator(fullConfig)
    this.differ = new SchemaDiffer(entities, fullConfig)
  }

  /**
   * Initialize migrations system
   * 1. Ensure migrations table exists
   * 2. Run pending migrations (file-based)
   * 3. Run auto-migration (schema diff)
   */
  async initialize(): Promise<void> {
    // Step 1: Ensure migrations table exists
    await this.runner.ensureMigrationsTable()

    // Step 2: Run pending file-based migrations
    await this.runPendingMigrations()

    // Step 3: Run auto-migration (schema diff)
    await this.runAutoMigration()
  }

  /**
   * Run pending file-based migrations
   */
  private async runPendingMigrations(): Promise<void> {
    const status = await this.runner.status()

    if (status.pendingCount === 0) {
      return
    }

    console.log(`\n📦 Found ${status.pendingCount} pending migration(s):`)
    for (const name of status.pending) {
      console.log(`   - ${name}`)
    }

    const result = await this.runner.run()

    if (result.executed.length > 0) {
      console.log(`\n✅ Executed ${result.executed.length} migration(s):`)
      for (const name of result.executed) {
        console.log(`   - ${name}`)
      }
    }

    if (result.failed.length > 0) {
      console.error(`\n❌ Failed to execute ${result.failed.length} migration(s):`)
      for (const name of result.failed) {
        console.error(`   - ${name}`)
      }

      throw new Error('Migration failed. Aborting.')
    }
  }

  /**
   * Run auto-migration (schema diff)
   */
  private async runAutoMigration(): Promise<void> {
    if (!this.differ) {
      return
    }

    // Get current database schema
    const dbSchema = await this.inspector.getSchema()

    // Compare with entity definitions
    const diff = await this.differ.diff(dbSchema)

    if (!diff.hasChanges) {
      return
    }

    // Display changes
    this.displaySchemaDiff(diff)

    // Handle based on configuration
    const config = this.getConfig()

    if (!config.autoMigrate) {
      // Auto-migration disabled - just show the changes and exit
      console.log('\n⚠️  Auto-migration is disabled. Set autoMigrate: true to apply changes.')

      if (config.killIfUpdate) {
        console.log('⚠️  Process will exit due to schema changes.')
        process.exit(1)
      }

      return
    }

    // Auto-migration enabled - prompt or auto-apply
    const shouldApply = config.noInteraction
      ? true
      : await this.promptUser('Apply these changes?')

    if (!shouldApply) {
      console.log('\n❌ Changes not applied.')

      if (config.killIfUpdate) {
        console.log('⚠️  Process will exit.')
        process.exit(1)
      }

      return
    }

    // Apply changes
    await this.applySchemaChanges(diff)
  }

  /**
   * Apply schema changes to database
   */
  private async applySchemaChanges(diff: SchemaDiff): Promise<void> {
    console.log('\n🔄 Applying schema changes...')

    let successCount = 0
    let errorCount = 0

    for (const change of diff.changes) {
      try {
        await this.db.unsafe(change.sql)
        console.log(`✅ ${change.description}`)
        successCount++
      }
      catch (error) {
        console.error(`❌ Failed: ${change.description}`)
        console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`)
        errorCount++

        // Stop on first error
        break
      }
    }

    if (errorCount > 0) {
      throw new Error(`Failed to apply schema changes. ${successCount} succeeded, ${errorCount} failed.`)
    }

    console.log(`\n✅ Successfully applied ${successCount} schema change(s).`)
  }

  /**
   * Display schema diff
   */
  private displaySchemaDiff(diff: SchemaDiff): void {
    console.log('\n🔍 Schema changes detected:')
    console.log('─'.repeat(60))

    for (const change of diff.changes) {
      const icon = change.destructive ? '⚠️ ' : '  '

      console.log(`${icon}${change.description}`)

      if (change.metadata) {
        if (change.metadata.oldValue !== undefined && change.metadata.newValue !== undefined) {
          console.log(`     ${change.metadata.oldValue} → ${change.metadata.newValue}`)
        }
      }
    }

    console.log('─'.repeat(60))
    console.log('\nSQL to be executed:')
    console.log('─'.repeat(60))

    for (const change of diff.changes) {
      console.log(`\n${change.sql};`)
    }

    console.log('─'.repeat(60))
  }

  /**
   * Prompt user for confirmation
   */
  private async promptUser(question: string): Promise<boolean> {
    // Use Bun's built-in prompt if available, otherwise use readline
    // eslint-disable-next-line no-alert
    const answer = prompt(`\n${question} [y/n]: `)

    return answer?.toLowerCase() === 'y'
  }

  // ========================================================================
  // Public API for Manual Migrations
  // ========================================================================

  /**
   * Create a new migration file
   */
  async create(name: string): Promise<string> {
    return this.generator.create(name)
  }

  /**
   * Run all pending migrations
   */
  async run(): Promise<void> {
    const result = await this.runner.run()

    if (result.executed.length > 0) {
      console.log(`✅ Executed ${result.executed.length} migration(s)`)
    }
    else {
      console.log('✅ No pending migrations')
    }

    if (result.failed.length > 0) {
      throw new Error(`Failed to execute ${result.failed.length} migration(s)`)
    }
  }

  /**
   * Rollback the last batch of migrations
   */
  async rollback(): Promise<void> {
    const result = await this.runner.rollback()

    if (result.executed.length > 0) {
      console.log(`✅ Rolled back ${result.executed.length} migration(s)`)
    }
    else {
      console.log('✅ No migrations to rollback')
    }

    if (result.failed.length > 0) {
      throw new Error(`Failed to rollback ${result.failed.length} migration(s)`)
    }
  }

  /**
   * Rollback all migrations
   */
  async reset(): Promise<void> {
    const result = await this.runner.reset()

    if (result.executed.length > 0) {
      console.log(`✅ Rolled back all ${result.executed.length} migration(s)`)
    }
    else {
      console.log('✅ No migrations to rollback')
    }

    if (result.failed.length > 0) {
      throw new Error(`Failed to rollback ${result.failed.length} migration(s)`)
    }
  }

  /**
   * Show migration status
   */
  async status(): Promise<void> {
    const status = await this.runner.status()

    console.log('\n📊 Migration Status')
    console.log('─'.repeat(60))
    console.log(`Total: ${status.total}`)
    console.log(`Executed: ${status.executedCount}`)
    console.log(`Pending: ${status.pendingCount}`)

    if (status.executed.length > 0) {
      console.log('\n✅ Executed migrations:')
      for (const record of status.executed) {
        console.log(`   ${record.name} (batch ${record.batch})`)
      }
    }

    if (status.pending.length > 0) {
      console.log('\n⏳ Pending migrations:')
      for (const name of status.pending) {
        console.log(`   ${name}`)
      }
    }

    console.log('─'.repeat(60))
  }

  /**
   * Generate migration file from current schema diff
   */
  async generate(name?: string): Promise<string> {
    if (!this.differ) {
      throw new Error('Schema differ not initialized')
    }

    const dbSchema = await this.inspector.getSchema()
    const diff = await this.differ.diff(dbSchema)

    if (!diff.hasChanges) {
      console.log('✅ No schema changes detected')

      return ''
    }

    const filePath = await this.generator.createFromChanges(diff.changes, name)

    console.log(`✅ Migration file created: ${filePath}`)

    return filePath
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private getConfig(): Required<MigrationConfig> {
    return {
      autoMigrate: this.config.autoMigrate ?? true,
      noInteraction: this.config.noInteraction ?? false,
      killIfUpdate: this.config.killIfUpdate ?? true,
      safeMigrations: this.config.safeMigrations ?? true,
      migrationsPath: this.config.migrationsPath ?? 'migrations',
      migrationsTable: this.config.migrationsTable ?? '_migrations',
    }
  }
}
