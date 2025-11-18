import type { MigrationConfig, SchemaChange } from './types'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// ============================================================================
// Migration Generator - Create Migration Files
// ============================================================================

export class MigrationGenerator {
  constructor(private config: Required<MigrationConfig>) {}

  /**
   * Create a new migration file
   */
  async create(name: string): Promise<string> {
    const timestamp = this.generateTimestamp()
    const fileName = `${timestamp}_${this.sanitizeName(name)}.ts`
    const filePath = join(this.config.migrationsPath, fileName)

    // Ensure migrations directory exists
    await this.ensureDirectory()

    // Generate migration content
    const content = this.generateEmptyMigration(fileName)

    // Write file
    await writeFile(filePath, content, 'utf-8')

    return filePath
  }

  /**
   * Create a migration file from schema changes (auto-migration)
   */
  async createFromChanges(changes: SchemaChange[], name?: string): Promise<string> {
    const timestamp = this.generateTimestamp()
    const migrationName = name || 'auto_migration'
    const fileName = `${timestamp}_${this.sanitizeName(migrationName)}.ts`
    const filePath = join(this.config.migrationsPath, fileName)

    // Ensure migrations directory exists
    await this.ensureDirectory()

    // Generate migration content from changes
    const content = this.generateMigrationFromChanges(fileName, changes)

    // Write file
    await writeFile(filePath, content, 'utf-8')

    return filePath
  }

  // ========================================================================
  // Template Generation
  // ========================================================================

  private generateEmptyMigration(fileName: string): string {
    const migrationName = fileName.replace('.ts', '')

    return `import type { Migration } from '@kaynooo/orm'

export const migration: Migration = {
  name: '${migrationName}',

  async up(db) {
    // Write your migration here
    // Example:
    // await db\`
    //   ALTER TABLE users
    //   ADD COLUMN bio TEXT
    // \`
  },

  async down(db) {
    // Write your rollback here
    // Example:
    // await db\`
    //   ALTER TABLE users
    //   DROP COLUMN bio
    // \`
  },
}
`
  }

  private generateMigrationFromChanges(fileName: string, changes: SchemaChange[]): string {
    const migrationName = fileName.replace('.ts', '')
    const upStatements = changes.map(c => c.sql)
    const downStatements = this.generateRollbackStatements(changes)

    const upSQL = upStatements.map(sql => `    await db\`${sql}\``).join('\n\n')
    const downSQL = downStatements.map(sql => `    await db\`${sql}\``).join('\n\n')

    return `import type { Migration } from '@kaynooo/orm'

// Auto-generated migration
// Changes detected:
${changes.map(c => `//   - ${c.description}`).join('\n')}

export const migration: Migration = {
  name: '${migrationName}',

  async up(db) {
${upSQL}
  },

  async down(db) {
${downSQL || '    // No automatic rollback generated'}
  },
}
`
  }

  private generateRollbackStatements(changes: SchemaChange[]): string[] {
    const rollback: string[] = []

    // Reverse order for rollback
    for (const change of changes.reverse()) {
      switch (change.type) {
      case 'CREATE_TABLE':
        rollback.push(`DROP TABLE ${change.tableName}`)

        break

      case 'DROP_TABLE':
        // Cannot auto-generate rollback for dropped tables
        rollback.push(`-- Cannot auto-rollback DROP TABLE ${change.tableName}`)

        break

      case 'ADD_COLUMN':
        if (change.metadata?.columnName) {
          rollback.push(`ALTER TABLE ${change.tableName} DROP COLUMN ${change.metadata.columnName}`)
        }

        break

      case 'DROP_COLUMN':
        // Cannot auto-generate rollback for dropped columns
        rollback.push(`-- Cannot auto-rollback DROP COLUMN ${change.tableName}.${change.metadata?.columnName}`)

        break

      case 'MODIFY_COLUMN':
        // Try to reverse the modification
        if (change.metadata?.columnName && change.metadata?.oldValue !== undefined) {
          const columnName = change.metadata.columnName

          if (change.sql.includes('TYPE')) {
            rollback.push(`ALTER TABLE ${change.tableName} ALTER COLUMN ${columnName} TYPE ${change.metadata.oldValue}`)
          }
          else if (change.sql.includes('SET NOT NULL')) {
            rollback.push(`ALTER TABLE ${change.tableName} ALTER COLUMN ${columnName} DROP NOT NULL`)
          }
          else if (change.sql.includes('DROP NOT NULL')) {
            rollback.push(`ALTER TABLE ${change.tableName} ALTER COLUMN ${columnName} SET NOT NULL`)
          }
          else if (change.sql.includes('SET DEFAULT')) {
            rollback.push(`ALTER TABLE ${change.tableName} ALTER COLUMN ${columnName} DROP DEFAULT`)
          }
          else if (change.sql.includes('DROP DEFAULT')) {
            rollback.push(`ALTER TABLE ${change.tableName} ALTER COLUMN ${columnName} SET DEFAULT ${change.metadata.oldValue}`)
          }
        }

        break

      default:
        rollback.push(`-- No rollback for ${change.type}`)
      }
    }

    return rollback.filter(s => s.trim() !== '')
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private generateTimestamp(): string {
    const now = new Date()
    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    const seconds = String(now.getSeconds()).padStart(2, '0')

    return `${year}${month}${day}${hours}${minutes}${seconds}`
  }

  private sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.config.migrationsPath, { recursive: true })
    }
    catch (error) {
      // Directory might already exist
    }
  }
}
