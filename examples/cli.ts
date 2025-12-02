#!/usr/bin/env bun

/**
 * CLI Entry Point Example
 *
 * This demonstrates how to use the ORM CLI in your project.
 * Copy this file to your project root and customize as needed.
 *
 * Usage:
 *   bun cli.ts migrate:create <name>
 *   bun cli.ts migrate:run
 *   bun cli.ts migrate:rollback
 *   bun cli.ts migrate:status
 *   bun cli.ts migrate:reset
 *   bun cli.ts migrate:generate [name]
 *   bun cli.ts db:seed [names...]
 */

import { orm, runCLI } from '../src'

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

    await runCLI(orm)
  }
  catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  finally {
    await orm.disconnect()
  }
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
