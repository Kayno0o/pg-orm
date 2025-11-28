#!/usr/bin/env bun

/**
 * Migration CLI Example
 *
 * A simple CLI tool for running migrations.
 * You can use this as a starting point for your own migration commands.
 *
 * Usage:
 *   bun examples/cli-migrations.ts create add_user_bio
 *   bun examples/cli-migrations.ts run
 *   bun examples/cli-migrations.ts rollback
 *   bun examples/cli-migrations.ts status
 *   bun examples/cli-migrations.ts reset
 *   bun examples/cli-migrations.ts generate
 */

import { orm } from '../src/orm'

// Parse command line arguments
const [command, ...args] = process.argv.slice(2)

async function main() {
  // Connect to database
  const dbUrl = process.env.DATABASE_URL

  if (!dbUrl) {
    console.error('❌ DATABASE_URL environment variable is required')
    console.error('   Example: DATABASE_URL=postgres://user:pass@localhost/mydb')
    process.exit(1)
  }

  try {
    // Connect with migrations disabled (we'll run them manually)
    await orm.connect(parseConnectionString(dbUrl))

    console.log('✅ Connected to database\n')

    // Execute command
    switch (command) {
    case 'create':
      await createMigration(args[0])

      break

    case 'run':
      await runMigrations()

      break

    case 'rollback':
      await rollbackMigrations()

      break

    case 'reset':
      await resetMigrations()

      break

    case 'status':
      await showStatus()

      break

    case 'generate':
      await generateMigration(args[0])

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
    console.error('   Usage: bun cli-migrations.ts create <name>')
    process.exit(1)
  }

  const filePath = await orm.migration.create(name)

  console.log(`✅ Created migration: ${filePath}`)
  console.log('\nNext steps:')
  console.log('1. Edit the migration file to add your changes')
  console.log('2. Run: bun cli-migrations.ts run')
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
  console.log('2. Run: bun cli-migrations.ts run')
}

function showHelp() {
  console.log(`
Migration CLI Tool

Usage:
  bun cli-migrations.ts <command> [options]

Commands:
  create <name>     Create a new migration file
  run               Run all pending migrations
  rollback          Rollback the last batch of migrations
  reset             Rollback all migrations (dangerous!)
  status            Show migration status
  generate [name]   Generate migration from schema changes

Examples:
  bun cli-migrations.ts create add_user_bio
  bun cli-migrations.ts run
  bun cli-migrations.ts rollback
  bun cli-migrations.ts status
  bun cli-migrations.ts generate sync_schema

Environment Variables:
  DATABASE_URL      PostgreSQL connection string (required)
                    Example: postgres://user:pass@localhost/mydb
`)
}

/** Parse PostgreSQL connection string */
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

// Run the CLI
main()
