import type { ORM } from './orm'
import { SeederRunner } from './seeder'

export async function runCLI(orm: ORM): Promise<void> {
  const [command, ...args] = process.argv.slice(2)

  try {
    switch (command) {
    case 'migrate:create':
      await createMigration(orm, args[0])

      break

    case 'migrate:run':
      await runMigrations(orm)

      break

    case 'migrate:rollback':
      await rollbackMigrations(orm)

      break

    case 'migrate:reset':
      await resetMigrations(orm)

      break

    case 'migrate:status':
      await showStatus(orm)

      break

    case 'migrate:generate':
      await generateMigration(orm, args[0])

      break

    case 'db:seed':
      await runSeeders(args)

      break

    case 'seed:create':
      await createSeeder(args[0])

      break

    case 'seed:list':
      await listSeeders()

      break

    case 'docs:draw':
      await drawSchema(orm)

      break

    default:
      showHelp()
      process.exit(1)
    }
  }
  catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

async function createMigration(orm: ORM, name?: string) {
  if (!name) {
    console.error('❌ Migration name is required')
    console.error('   Usage: migrate:create <name>')
    process.exit(1)
  }

  const filePath = await orm.migration.create(name)

  console.log(`✅ Created migration: ${filePath}`)
  console.log('\nNext steps:')
  console.log('1. Edit the migration file to add your changes')
  console.log('2. Run: migrate:run')
}

async function runMigrations(orm: ORM) {
  console.log('🔄 Running pending migrations...\n')
  await orm.migration.run()
}

async function rollbackMigrations(orm: ORM) {
  console.log('⏪ Rolling back last batch...\n')
  await orm.migration.rollback()
}

async function resetMigrations(orm: ORM) {
  console.log('⚠️  This will rollback ALL migrations!')
  // eslint-disable-next-line no-alert
  const answer = prompt('Are you sure? [y/n]: ')

  if (answer?.toLowerCase() !== 'y') {
    console.log('❌ Cancelled')

    return
  }

  console.log('\n🔄 Resetting all migrations...\n')
  await orm.migration.reset()
}

async function showStatus(orm: ORM) {
  await orm.migration.status()
}

async function generateMigration(orm: ORM, name?: string) {
  console.log('🔍 Detecting schema changes...\n')

  const filePath = await orm.migration.generate(name)

  if (!filePath) {
    console.log('✅ No schema changes detected')

    return
  }

  console.log('\nNext steps:')
  console.log('1. Review the generated migration file')
  console.log('2. Run: migrate:run')
}

async function createSeeder(name?: string) {
  if (!name) {
    console.error('❌ Seeder name is required')
    console.error('   Usage: seed:create <name>')
    process.exit(1)
  }

  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')

  const seedsDir = resolve(process.cwd(), 'seeds')

  if (!existsSync(seedsDir)) {
    mkdirSync(seedsDir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0]?.replace('T', '_') || ''
  const fileName = `${timestamp}_${name}.ts`
  const filePath = resolve(seedsDir, fileName)

  const template = `import type { SeederContext } from '@kaynooo/pg-orm'

export default {
  name: '${name}',
  groups: ['development'], // Optional: specify one or more groups
  async run({ db }: SeederContext) {
    // Add your seeding logic here
    // Example:
    // await db\`INSERT INTO users (name, email) VALUES ('John Doe', 'john@example.com')\`
  }
}
`

  writeFileSync(filePath, template)

  console.log(`✅ Created seeder: ${filePath}`)
  console.log('\nNext steps:')
  console.log('1. Edit the seeder file to add your seeding logic')
  console.log('2. Optionally set groups: ["development", "testing", "production"]')
  console.log('3. Run: db:seed or db:seed --group development')
}

async function listSeeders() {
  const runner = new SeederRunner()

  await runner.listSeeders()
}

async function runSeeders(args: string[]) {
  const runner = new SeederRunner()

  // Parse arguments
  let group: string | undefined
  const seederNames: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--group' && args[i + 1]) {
      group = args[i + 1]
      i++ // Skip next arg
    }
    else if (!args[i]?.startsWith('--')) {
      seederNames.push(args[i]!)
    }
  }

  // Build status message
  const filters: string[] = []

  if (group)
    filters.push(`group: ${group}`)

  if (seederNames.length > 0)
    filters.push(`names: ${seederNames.join(', ')}`)

  const filterMsg = filters.length > 0 ? ` (${filters.join(', ')})` : ''

  console.log(`🌱 Running seeders${filterMsg}...\n`)

  await runner.run({
    seederNames: seederNames.length > 0 ? seederNames : undefined,
    group,
  })
}

async function drawSchema(orm: ORM) {
  console.log('📊 Generating schema diagram...\n')

  const entities = (orm as any).entities as Map<string, any>

  if (entities.size === 0) {
    console.log('⚠️  No entities registered')
    console.log('   Tip: Make sure you call orm.repo(Entity) before running docs:draw')

    return
  }

  const mermaidLines: string[] = [
    'erDiagram',
    '',
  ]

  const relationships: string[] = []

  for (const [tableName, entityDef] of entities) {
    const fields: string[] = []
    const schema = entityDef.schema

    fields.push('int id PK')

    for (const [fieldName, fieldConfig] of Object.entries(schema)) {
      const config = fieldConfig as any
      let fieldType = ''

      switch (config.type) {
      case 'string':
        fieldType = config.maxLength ? `varchar(${config.maxLength})` : 'text'

        break

      case 'number':
        fieldType = config.integer ? 'int' : 'float'

        break

      case 'boolean':
        fieldType = 'boolean'

        break

      case 'json':
      case 'jsonb':
        fieldType = 'jsonb'

        break

      case 'uuid':
        fieldType = 'uuid'

        break

      case 'timestamp':
        fieldType = 'timestamp'

        break

      case 'date':
        fieldType = 'date'

        break

      case 'array':
        fieldType = `${config.arrayType}[]`

        break

      case 'enum':
        fieldType = 'enum'

        break

      case 'blob':
        fieldType = 'bytea'

        break

      case 'foreignKey':
        fieldType = 'int'

        relationships.push(
          `  ${tableName} }o--|| ${config.foreignKey.table} : "${fieldName}"`,
        )

        break

      default:
        fieldType = 'unknown'
      }

      const nullable = config.nullable ? '' : ' "NOT NULL"'
      const unique = config.unique ? ' "UNIQUE"' : ''
      const fkMarker = config.type === 'foreignKey' ? ' FK' : ''

      fields.push(`${fieldType} ${fieldName}${fkMarker}${nullable}${unique}`)
    }

    mermaidLines.push(`  ${tableName} {`)

    for (const field of fields) {
      mermaidLines.push(`    ${field}`)
    }

    mermaidLines.push('  }')
    mermaidLines.push('')
  }

  if (relationships.length > 0) {
    mermaidLines.push(...relationships)
  }

  const mermaidContent = mermaidLines.join('\n')
  const { writeFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')

  const outputPath = resolve(process.cwd(), 'schema.mermaid')

  writeFileSync(outputPath, mermaidContent)

  console.log(`✅ Schema diagram generated: ${outputPath}`)
  console.log(`\n📝 Entity count: ${entities.size}`)
  console.log(`🔗 Relationship count: ${relationships.length}`)
  console.log('\nTo view the diagram:')
  console.log('  - Open in VS Code with Mermaid extension')
  console.log('  - Paste into https://mermaid.live')
  console.log('  - Use any Mermaid renderer')
}

function showHelp() {
  console.log(`
@kaynooo/pg-orm CLI

Usage:
  <command> [options]

Migration Commands:
  migrate:create <name>     Create a new migration file
  migrate:run               Run all pending migrations
  migrate:rollback          Rollback the last batch of migrations
  migrate:reset             Rollback all migrations (dangerous!)
  migrate:status            Show migration status
  migrate:generate [name]   Generate migration from schema changes

Seeding Commands:
  seed:create <name>        Create a new seeder file
  seed:list                 List all available seeders
  db:seed [options] [names...]  Run database seeders

Seeding Options:
  --group <group>           Run only seeders in specified group

Documentation Commands:
  docs:draw                 Generate Mermaid.js ER diagram from schema

Examples:
  migrate:create add_user_bio
  migrate:run
  migrate:rollback
  migrate:status
  migrate:generate sync_schema
  seed:create users
  seed:list                         # List all seeders grouped
  db:seed                           # Run all seeders
  db:seed --group development       # Run seeders in 'development' group
  db:seed --group testing users     # Run 'users' seeder in 'testing' group
  db:seed users posts               # Run specific seeders
  docs:draw                         # Generate schema.mermaid file
`)
}
