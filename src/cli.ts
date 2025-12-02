#!/usr/bin/env bun

import { orm } from './orm'
import { SeederRunner } from './seeder'

const [command, ...args] = process.argv.slice(2)

async function main() {
  const dbUrl = process.env.DATABASE_URL

  if (!dbUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    console.error('   Example: DATABASE_URL=postgres://user:pass@localhost/mydb')
    process.exit(1)
  }

  try {
    await orm.connect(parseConnectionString(dbUrl))

    console.log('✅ Connected to database\n')

    switch (command) {
    case 'migrate:create':
      await createMigration(args[0])

      break

    case 'migrate:run':
      await runMigrations()

      break

    case 'migrate:rollback':
      await rollbackMigrations()

      break

    case 'migrate:reset':
      await resetMigrations()

      break

    case 'migrate:status':
      await showStatus()

      break

    case 'migrate:generate':
      await generateMigration(args[0])

      break

    case 'db:seed':
      await runSeeders(args)

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
  finally {
    await orm.disconnect()
  }
}

async function createMigration(name?: string) {
  if (!name) {
    console.error('❌ Migration name is required')
    console.error('   Usage: bun cli.ts migrate:create <name>')
    process.exit(1)
  }

  const filePath = await orm.migration.create(name)

  console.log(`✅ Created migration: ${filePath}`)
  console.log('\nNext steps:')
  console.log('1. Edit the migration file to add your changes')
  console.log('2. Run: bun cli.ts migrate:run')
}

async function runMigrations() {
  console.log('🔄 Running pending migrations...\n')
  await orm.migration.run()
}

async function rollbackMigrations() {
  console.log('⏪ Rolling back last batch...\n')
  await orm.migration.rollback()
}

async function resetMigrations() {
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

async function showStatus() {
  await orm.migration.status()
}

async function generateMigration(name?: string) {
  console.log('🔍 Detecting schema changes...\n')

  const filePath = await orm.migration.generate(name)

  if (!filePath) {
    console.log('✅ No schema changes detected')

    return
  }

  console.log('\nNext steps:')
  console.log('1. Review the generated migration file')
  console.log('2. Run: bun cli.ts migrate:run')
}

async function runSeeders(seederNames?: string[]) {
  const runner = new SeederRunner()

  if (seederNames && seederNames.length > 0) {
    console.log(`🌱 Running specific seeders: ${seederNames.join(', ')}\n`)
    await runner.run(seederNames)
  }
  else {
    console.log('🌱 Running all seeders...\n')
    await runner.run()
  }
}

function showHelp() {
  console.log(`
@kaynooo/pg-orm CLI

Usage:
  bun cli.ts <command> [options]

Migration Commands:
  migrate:create <name>     Create a new migration file
  migrate:run               Run all pending migrations
  migrate:rollback          Rollback the last batch of migrations
  migrate:reset             Rollback all migrations (dangerous!)
  migrate:status            Show migration status
  migrate:generate [name]   Generate migration from schema changes

Seeding Commands:
  db:seed [names...]        Run database seeders (all or specific ones)

Examples:
  bun cli.ts migrate:create add_user_bio
  bun cli.ts migrate:run
  bun cli.ts migrate:rollback
  bun cli.ts migrate:status
  bun cli.ts migrate:generate sync_schema
  bun cli.ts db:seed
  bun cli.ts db:seed users posts

Environment Variables:
  DATABASE_URL      PostgreSQL connection string (required)
                    Example: postgres://user:pass@localhost/mydb
`)
}

function parseConnectionString(url: string) {
  const parsed = new URL(url)

  return {
    hostname: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port) : 5432,
    database: parsed.pathname.slice(1),
    username: parsed.username,
    password: parsed.password,
  }
}

main()
