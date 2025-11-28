import type { SQL } from 'bun'
import type { EntityDefinition } from '../types'
import type { MigrationConfig, SchemaDiff } from './types'
import { MigrationGenerator } from './generator'
import { MigrationRunner } from './runner'
import { SchemaDiffer } from './schema-differ'
import { SchemaInspector } from './schema-inspector'

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

  async initialize(): Promise<void> {
    await this.runner.ensureMigrationsTable()
    await this.runPendingMigrations()
    await this.runAutoMigration()
  }

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

  private async runAutoMigration(): Promise<void> {
    if (!this.differ) {
      return
    }

    const dbSchema = await this.inspector.getSchema()
    const diff = await this.differ.diff(dbSchema)

    if (!diff.hasChanges) {
      return
    }

    const migrationHash = this.hashChanges(diff.changes)
    const alreadyApplied = await this.isAutoMigrationApplied(migrationHash)

    if (alreadyApplied) {
      console.log('\n✅ Schema changes already applied in previous run. Skipping.')

      return
    }

    this.displaySchemaDiff(diff)
    const config = this.getConfig()

    if (!config.autoMigrate) {
      console.log('\n⚠️  Auto-migration is disabled. Set autoMigrate: true to apply changes.')

      if (config.killIfUpdate) {
        console.log('⚠️  Process will exit due to schema changes.')
        process.exit(1)
      }

      return
    }

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

    await this.applySchemaChanges(diff)
    await this.recordAutoMigration(migrationHash)
  }

  private async applySchemaChanges(diff: SchemaDiff): Promise<void> {
    console.log('\n🔄 Applying schema changes...')

    let successCount = 0
    let errorCount = 0

    try {
      await this.db.begin(async (tx) => {
        for (const change of diff.changes) {
          try {
            await tx.unsafe(change.sql)
            console.log(`✅ ${change.description}`)
            successCount++
          }
          catch (error) {
            console.error(`❌ Failed: ${change.description}`)
            console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`)
            errorCount++

            throw error
          }
        }
      })
    }
    catch (error) {
      throw new Error(
        `Failed to apply schema changes. ${successCount} succeeded before rollback, ${errorCount} failed. All changes rolled back.`,
      )
    }

    console.log(`\n✅ Successfully applied ${successCount} schema change(s).`)
  }

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

  private async promptUser(question: string): Promise<boolean> {
    // eslint-disable-next-line no-alert
    const answer = prompt(`\n${question} [y/n]: `)

    return answer?.toLowerCase() === 'y'
  }

  async create(name: string): Promise<string> {
    return this.generator.create(name)
  }

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

  private hashChanges(changes: { sql: string, description: string }[]): string {
    const sqlStatements = changes.map(c => c.sql).sort().join('\n')
    let hash = 0

    for (let i = 0; i < sqlStatements.length; i++) {
      const char = sqlStatements.charCodeAt(i)

      hash = (hash << 5) - hash + char
      hash &= hash
    }

    return `auto_${Math.abs(hash).toString(36)}`
  }

  private async isAutoMigrationApplied(migrationHash: string): Promise<boolean> {
    const config = this.getConfig()
    const [result] = await this.db`
      SELECT COUNT(*) as count
      FROM ${this.db(config.migrationsTable)}
      WHERE name = ${migrationHash}
    `

    return (result?.count ?? 0) > 0
  }

  private async recordAutoMigration(migrationHash: string): Promise<void> {
    const config = this.getConfig()
    const [batchResult] = await this.db`
      SELECT COALESCE(MAX(batch), 0) + 1 as batch
      FROM ${this.db(config.migrationsTable)}
    `
    const batch = batchResult?.batch ?? 1

    await this.db`
      INSERT INTO ${this.db(config.migrationsTable)} (name, batch)
      VALUES (${migrationHash}, ${batch})
      ON CONFLICT (name) DO NOTHING
    `
    console.log(`\n📝 Recorded auto-migration: ${migrationHash}`)
  }

  async clearAutoMigrations(): Promise<void> {
    const config = this.getConfig()

    await this.db`
      DELETE FROM ${this.db(config.migrationsTable)}
      WHERE name LIKE 'auto_%'
    `
  }
}
