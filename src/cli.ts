#!/usr/bin/env bun

import type { PgOrmConfig } from './define-config'
import type { MigrationFile } from './migration/index'
import type { Database } from './sql/database'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MigrationError, sanitizePgErrorMessage } from './errors/index'
import { applyMigrationFiles, pendingMigrations, syncMigration } from './migration/files'
import { migrationName } from './migration/history'
import { generateMigration, getMigrationStatus } from './migration/index'

interface Flags { allowDestructive: boolean, dryRun: boolean, raw: boolean }

const FLAGS: Record<string, keyof Flags> = { '--allow-destructive': 'allowDestructive', '--dry-run': 'dryRun', '--raw': 'raw' }

// A flag a command ignores is refused, so `rollback --dry-run` never rolls back for real; `--raw` applies to every command.
const COMMAND_FLAGS: Record<string, (keyof Flags)[]> = { generate: ['allowDestructive', 'dryRun'], sync: ['allowDestructive', 'dryRun'], apply: ['dryRun'] }

async function loadConfig(): Promise<Required<Pick<PgOrmConfig, 'migrationsDir'>> & PgOrmConfig> {
  const cfgPath = resolve(process.cwd(), 'pg-orm.config.ts')

  if (!existsSync(cfgPath)) {
    console.error('pg-orm.config.ts not found in current directory')
    process.exit(1)
  }

  const mod = (await import(cfgPath)) as { default: PgOrmConfig }
  const cfg = mod.default

  if (!cfg?.db) {
    console.error('pg-orm.config.ts must export default { db, migrationsDir?, ignoreTables? }')
    process.exit(1)
  }

  return { ...cfg, migrationsDir: cfg.migrationsDir ?? 'migrations' }
}

function writeMigration(dir: string, name: string, up: string, down: string): string {
  mkdirSync(dir, { recursive: true })
  const filename = `${name}.sql`

  writeFileSync(join(dir, filename), `-- migrate:up\n${up}\n\n-- migrate:down\n${down}`, 'utf8')

  return filename
}

function printMigration(file: MigrationFile): void {
  console.log(`-- migrate:up\n${file.up}\n\n-- migrate:down\n${file.down}`)
}

async function cmdStatus(cfg: PgOrmConfig & { migrationsDir: string }): Promise<void> {
  const { db } = cfg
  const { drift, hasDrift } = await getMigrationStatus(db, db.getTablesRegistry(), db.schema, cfg.ignoreTables)

  if (!hasDrift) {
    console.log('Schema: no drift')
  }
  else {
    console.log(`Schema drift (${drift.length} op${drift.length === 1 ? '' : 's'}):`)
    for (const op of drift)
      console.log(`  ${op.destructive ? '[destructive] ' : ''}${op.description}`)
  }

  const pending = await pendingMigrations(db, cfg.migrationsDir)

  if (pending.length > 0) {
    console.log(`\nPending files (${pending.length}):`)
    for (const f of pending) console.log(`  ${f}`)
  }
  else {
    console.log('Files: all applied')
  }
}

// The diff reads the live database, so a file it has not applied would be diffed again into the new one, and a rebuild written from the stale table would drop what that file adds.
async function refusePending(cfg: PgOrmConfig & { migrationsDir: string }, command: string): Promise<void> {
  const pending = await pendingMigrations(cfg.db, cfg.migrationsDir)

  if (pending.length > 0)
    throw new MigrationError(`${pending.length} migration file(s) not applied yet: ${pending.join(', ')}. Run \`pg-orm apply\` before \`pg-orm ${command}\`.`, 'diff')
}

async function cmdGenerate(cfg: PgOrmConfig & { migrationsDir: string }, flags: Flags): Promise<void> {
  const { db } = cfg

  await refusePending(cfg, 'generate')

  const file = await generateMigration(db, db.getTablesRegistry(), { schema: db.schema, allowDestructive: flags.allowDestructive || flags.dryRun, ignoreTables: cfg.ignoreTables })

  if (!file) {
    console.log('No drift, nothing to generate')

    return
  }

  if (flags.dryRun)
    printMigration(file)
  else
    console.log(`Generated: ${join(cfg.migrationsDir, writeMigration(cfg.migrationsDir, file.name, file.up, file.down))}`)
}

async function cmdApply(db: Database, dir: string, flags: Flags): Promise<void> {
  if (flags.dryRun) {
    const pending = await pendingMigrations(db, dir)

    if (pending.length === 0)
      console.log('Nothing to apply')

    for (const filename of pending)
      console.log(`Would apply: ${filename}`)

    return
  }

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
  const slug = label.trim().replace(/\W+/g, '_').replace(/^_|_$/g, '') || 'migration'
  const filename = writeMigration(dir, migrationName(slug), '', '')

  console.log(`Created: ${join(dir, filename)}`)
}

// The file is written once the migration is applied and recorded, so a failed apply leaves none behind.
async function cmdSync(cfg: PgOrmConfig & { migrationsDir: string }, flags: Flags): Promise<void> {
  const { db } = cfg

  await refusePending(cfg, 'sync')

  const file = await syncMigration(db, db.getTablesRegistry(), { schema: db.schema, ignoreTables: cfg.ignoreTables, ...flags })

  if (!file) {
    console.log('No drift, nothing to sync')

    return
  }

  if (flags.dryRun) {
    printMigration(file)

    return
  }

  console.log(`Applied: ${join(cfg.migrationsDir, writeMigration(cfg.migrationsDir, file.name, file.up, file.down))}`)
}

const HELP = `Usage: pg-orm <command> [flags]

Commands:
  status          Show schema drift and pending migration files
  generate        Generate a migration file from current drift
  new [name]      Create an empty migration file
  apply           Apply pending migration files to the database
  rollback [n]    Roll back the last N applied migrations (default: 1)
  sync            Generate, apply and record a migration, then write its file

Flags:
  --allow-destructive   Let generate and sync drop tables, columns and constraints
  --dry-run             Print what generate, sync or apply would do, changing nothing
  --raw                 Print errors with the row values they quote, which are redacted by default`

function parseArgs(argv: string[]): { positional: string[], flags: Flags } {
  const flags: Flags = { allowDestructive: false, dryRun: false, raw: false }
  const positional: string[] = []

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg)

      continue
    }

    const flag = FLAGS[arg]

    if (!flag) {
      console.error(`Unknown flag: ${arg}\n\n${HELP}`)
      process.exit(1)
    }

    flags[flag] = true
  }

  return { positional, flags }
}

async function main(): Promise<void> {
  const { positional: [cmd, arg], flags } = parseArgs(process.argv.slice(2))

  // A CI log outlives the run, so a value an error quotes stays redacted unless asked for.
  if (flags.raw)
    process.env.REDACT_QUERY_LOGS = '0'

  if (!cmd || cmd === 'help') {
    console.log(HELP)

    return
  }

  const refused = Object.entries(FLAGS).find(([, flag]) => flag !== 'raw' && flags[flag] && !COMMAND_FLAGS[cmd]?.includes(flag))

  if (refused) {
    console.error(`${refused[0]} does nothing for ${cmd}

${HELP}`)
    process.exit(1)
  }

  const cfg = await loadConfig()

  if (cmd === 'new') {
    cmdNew(cfg.migrationsDir, arg ?? '')
    await cfg.db.close()

    return
  }

  try {
    if (cmd === 'status') {
      await cmdStatus(cfg)
    }
    else if (cmd === 'generate') {
      await cmdGenerate(cfg, flags)
    }
    else if (cmd === 'apply') {
      await cmdApply(cfg.db, cfg.migrationsDir, flags)
    }
    else if (cmd === 'rollback') {
      await cmdRollback(cfg.db, Number.parseInt(arg ?? '1', 10))
    }
    else if (cmd === 'sync') {
      await cmdSync(cfg, flags)
    }
    else {
      console.error(`Unknown command: ${cmd}\n\n${HELP}`)
      process.exit(1)
    }
  }
  finally {
    await cfg.db.close()
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
        console.error(`  caused by: ${sanitizePgErrorMessage(err.cause.message)}`)
    }
    else {
      console.error(String(err))
    }

    process.exit(1)
  }
})()
