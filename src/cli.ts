#!/usr/bin/env bun

import type { PgOrmConfig } from './define-config'
import type { Database } from './sql/database'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { applyMigrationFiles, pendingMigrationFiles } from './migration/files'
import {
  applyMigration,
  djb2Hash,
  ensureMigrationTable,
  generateMigration,
  getMigrationHistory,
  getMigrationStatus,

  recordMigration,
} from './migration/index'

async function loadConfig(): Promise<{ db: Database, dir: string }> {
  const cfgPath = resolve(process.cwd(), 'pg-orm.config.ts')

  if (!existsSync(cfgPath)) {
    console.error('pg-orm.config.ts not found in current directory')
    process.exit(1)
  }

  const mod = (await import(cfgPath)) as { default: PgOrmConfig }
  const cfg = mod.default

  if (!cfg?.db) {
    console.error('pg-orm.config.ts must export default { db, migrationsDir? }')
    process.exit(1)
  }

  return { db: cfg.db, dir: cfg.migrationsDir ?? 'migrations' }
}

function writeMigration(dir: string, name: string, up: string, down: string): string {
  mkdirSync(dir, { recursive: true })
  const filename = `${name}.sql`

  writeFileSync(join(dir, filename), `-- migrate:up\n${up}\n\n-- migrate:down\n${down}`, 'utf8')

  return filename
}

async function cmdStatus(db: Database, dir: string): Promise<void> {
  const { drift, hasDrift } = await getMigrationStatus(db, db.getTablesRegistry())

  if (!hasDrift) {
    console.log('Schema: no drift')
  }
  else {
    console.log(`Schema drift (${drift.length} op${drift.length === 1 ? '' : 's'}):`)
    for (const op of drift)
      console.log(`  ${op.destructive ? '[destructive] ' : ''}${op.description}`)
  }

  const history = await getMigrationHistory(db)
  const pending = pendingMigrationFiles(dir, history)

  if (pending.length > 0) {
    console.log(`\nPending files (${pending.length}):`)
    for (const f of pending) console.log(`  ${f}`)
  }
  else {
    console.log('Files: all applied')
  }
}

async function cmdGenerate(db: Database, dir: string): Promise<void> {
  const file = await generateMigration(db, db.getTablesRegistry())

  if (!file) {
    console.log('No drift — nothing to generate')

    return
  }

  console.log(`Generated: ${join(dir, writeMigration(dir, file.name, file.up, file.down))}`)
}

async function cmdApply(db: Database, dir: string): Promise<void> {
  const applied = await applyMigrationFiles(db, dir)

  if (applied.length === 0)
    console.log('Nothing to apply')

  for (const filename of applied)
    console.log(`Applied: ${filename}`)
}

async function cmdRollback(db: Database, count: number): Promise<void> {
  const { rolledBack } = await db.rollback(count)

  if (rolledBack.length === 0) {
    console.log('Nothing to roll back')

    return
  }

  for (const name of rolledBack) console.log(`Rolled back: ${name}`)
}

function cmdNew(dir: string, label: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const slug = label.trim().replace(/\W+/g, '_').replace(/^_|_$/g, '') || 'migration'
  const filename = writeMigration(dir, `${timestamp}_${slug}`, '', '')

  console.log(`Created: ${join(dir, filename)}`)
}

async function cmdSync(db: Database, dir: string): Promise<void> {
  const file = await generateMigration(db, db.getTablesRegistry())

  if (!file) {
    console.log('No drift — nothing to sync')

    return
  }

  const filename = writeMigration(dir, file.name, file.up, file.down)

  console.log(`Generated: ${join(dir, filename)}`)
  await ensureMigrationTable(db)
  await applyMigration(db, file.up)
  await recordMigration(db, {
    name: file.name,
    sqlHash: djb2Hash(file.up),
    upSql: file.up,
    downSql: file.down,
    direction: 'up',
  })
  console.log(`Applied: ${filename}`)
}

const HELP = `Usage: pg-orm <command>

Commands:
  status          Show schema drift and pending migration files
  generate        Generate a migration file from current drift
  new [name]      Create an empty migration file
  apply           Apply pending migration files to the database
  rollback [n]    Roll back the last N applied migrations (default: 1)
  sync            Generate + apply a migration file in one step`

async function main(): Promise<void> {
  process.env.REDACT_QUERY_LOGS ??= '0'

  const [,, cmd, arg] = process.argv

  if (!cmd || cmd === 'help') {
    console.log(HELP)

    return
  }

  if (cmd === 'new') {
    const { dir } = await loadConfig()

    cmdNew(dir, arg ?? '')

    return
  }

  const { db, dir } = await loadConfig()

  try {
    if (cmd === 'status') {
      await cmdStatus(db, dir)
    }
    else if (cmd === 'generate') {
      await cmdGenerate(db, dir)
    }
    else if (cmd === 'apply') {
      await cmdApply(db, dir)
    }
    else if (cmd === 'rollback') {
      await cmdRollback(db, Number.parseInt(arg ?? '1', 10))
    }
    else if (cmd === 'sync') {
      await cmdSync(db, dir)
    }
    else {
      console.error(`Unknown command: ${cmd}\n\n${HELP}`)
      process.exit(1)
    }
  }
  finally {
    await db.close()
  }
}

void (async () => {
  try {
    await main()
  }
  catch (err) {
    if (err instanceof Error) {
      console.error(`${err.name}: ${err.message}`)

      if (err.cause instanceof Error)
        console.error(`  caused by: ${err.cause.message}`)
    }
    else {
      console.error(String(err))
    }

    process.exit(1)
  }
})()
