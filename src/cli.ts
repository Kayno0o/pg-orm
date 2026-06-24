#!/usr/bin/env bun

import type { MigrationHistoryEntry } from './migration/index'
import type { Database } from './sql/database'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  applyMigration,
  djb2Hash,
  ensureMigrationTable,
  generateMigration,
  getMigrationHistory,
  getMigrationStatus,

  recordMigration,
} from './migration/index'

interface Config {
  db: Database
  migrationsDir?: string
}

const SQL_EXT_RE = /\.sql$/
const MIGRATE_DOWN_RE = /\n-- migrate:down\n/
const MIGRATE_UP_RE = /^-- migrate:up\n/

async function loadConfig(): Promise<{ db: Database, dir: string }> {
  const cfgPath = resolve(process.cwd(), 'pg-orm.config.ts')

  if (!existsSync(cfgPath)) {
    console.error('pg-orm.config.ts not found in current directory')
    process.exit(1)
  }

  const mod = (await import(cfgPath)) as { default: Config }
  const cfg = mod.default

  if (!cfg?.db) {
    console.error('pg-orm.config.ts must export default { db, migrationsDir? }')
    process.exit(1)
  }

  return { db: cfg.db, dir: cfg.migrationsDir ?? 'migrations' }
}

function parseFile(content: string): { up: string, down: string } {
  const [up = '', down = ''] = content.split(MIGRATE_DOWN_RE)

  return { up: up.replace(MIGRATE_UP_RE, ''), down }
}

function writeMigration(dir: string, name: string, up: string, down: string): string {
  mkdirSync(dir, { recursive: true })
  const filename = `${name}.sql`

  writeFileSync(join(dir, filename), `-- migrate:up\n${up}\n\n-- migrate:down\n${down}`, 'utf8')

  return filename
}

function pendingFiles(dir: string, history: MigrationHistoryEntry[]): string[] {
  if (!existsSync(dir))
    return []

  return readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .filter((f) => {
      const name = f.replace(SQL_EXT_RE, '')
      const ups = history.filter(h => h.name === name && h.direction === 'up').length
      const downs = history.filter(h => h.name === name && h.direction === 'down').length

      return ups <= downs
    })
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
  const pending = pendingFiles(dir, history)

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
  await ensureMigrationTable(db)
  const history = await getMigrationHistory(db)
  const pending = pendingFiles(dir, history)

  if (pending.length === 0) {
    console.log('Nothing to apply')

    return
  }

  for (const filename of pending) {
    const name = filename.replace(SQL_EXT_RE, '')
    const { up, down } = parseFile(readFileSync(join(dir, filename), 'utf8'))

    await applyMigration(db, up)
    await recordMigration(db, { name, sqlHash: djb2Hash(up), upSql: up, downSql: down, direction: 'up' })
    console.log(`Applied: ${filename}`)
  }
}

async function cmdRollback(db: Database, count: number): Promise<void> {
  const { rolledBack } = await db.rollback(count)

  if (rolledBack.length === 0) {
    console.log('Nothing to roll back')

    return
  }

  for (const name of rolledBack) console.log(`Rolled back: ${name}`)
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
  apply           Apply pending migration files to the database
  rollback [n]    Roll back the last N applied migrations (default: 1)
  sync            Generate + apply a migration file in one step`

async function main(): Promise<void> {
  const [,, cmd, arg] = process.argv

  if (!cmd || cmd === 'help') {
    console.log(HELP)

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
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
})()
