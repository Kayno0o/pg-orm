#!/usr/bin/env bun

import type { PgOrmConfig } from './define-config'
import type { MigrationFile } from './migration/index'
import type { Database } from './sql/database'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { badUsage, Exit, fail, parse, runCli } from '@kaynooo/cli-kit'
import { MigrationError, sanitizePgErrorMessage } from './errors/index'
import { applyMigrationFiles, migrationFiles, refuseInconsistent, syncMigration } from './migration/files'
import { migrationName } from './migration/history'
import { generateMigration, getMigrationStatus } from './migration/index'

const COUNT_RE = /^[1-9]\d*$/

const RAW = { type: 'boolean', description: 'print errors with the row values they quote, which are redacted by default' } as const
const ALLOW_DESTRUCTIVE = { type: 'boolean', description: 'let generate and sync drop tables, columns and constraints' } as const
const DRY_RUN = { type: 'boolean', description: 'print what would happen, changing nothing' } as const

interface Flags { allowDestructive?: boolean, dryRun?: boolean }

type Config = PgOrmConfig & { migrationsDir: string }

async function loadConfig(): Promise<Config> {
  const cfgPath = resolve(process.cwd(), 'pg-orm.config.ts')

  if (!existsSync(cfgPath))
    fail('pg-orm.config.ts not found in current directory', 1)

  const mod = (await import(cfgPath)) as { default: PgOrmConfig }
  const cfg = mod.default

  if (!cfg?.db)
    fail('pg-orm.config.ts must export default { db, migrationsDir?, ignoreTables? }', 1)

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

function printFiles(title: string, files: string[]): void {
  if (files.length === 0)
    return

  console.log(`\n${title} (${files.length}):`)
  for (const f of files) console.log(`  ${f}`)
}

// With `check`, anything left to do or out of line exits 1, so a CI step can gate on it.
async function cmdStatus(cfg: Config, check: boolean): Promise<number> {
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

  const files = await migrationFiles(db, cfg.migrationsDir)

  if (files.pending.length === 0)
    console.log('Files: all applied')

  printFiles('Pending files', files.pending)
  printFiles('Pending files sorting before an applied file', files.outOfOrder)
  printFiles('Applied files changed since they ran', files.edited)

  return check && (hasDrift || files.pending.length > 0 || files.edited.length > 0) ? 1 : 0
}

// The diff reads the live database, so a file it has not applied would be diffed again into the new one, and a rebuild written from the stale table would drop what that file adds.
async function refusePending(cfg: Config, command: string): Promise<void> {
  const { pending } = await migrationFiles(cfg.db, cfg.migrationsDir)

  if (pending.length > 0)
    throw new MigrationError(`${pending.length} migration file(s) not applied yet: ${pending.join(', ')}. Run \`pg-orm apply\` before \`pg-orm ${command}\`.`, 'diff')
}

async function cmdGenerate(cfg: Config, flags: Flags): Promise<void> {
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

async function cmdApply(db: Database, dir: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    const files = await migrationFiles(db, dir)
    const { pending } = files

    refuseInconsistent(files)

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
async function cmdSync(cfg: Config, flags: Flags): Promise<void> {
  const { db } = cfg

  await refusePending(cfg, 'sync')

  const file = await syncMigration(db, db.getTablesRegistry(), { schema: db.schema, ignoreTables: cfg.ignoreTables, allowDestructive: flags.allowDestructive, dryRun: flags.dryRun })

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

// A CI log outlives the run, so a value an error quotes stays redacted unless asked for.
async function withConfig(raw: boolean | undefined, run: (cfg: Config) => Promise<number | void> | void): Promise<number> {
  if (raw)
    process.env.REDACT_QUERY_LOGS = '0'

  const cfg = await loadConfig()

  try {
    return await run(cfg) ?? 0
  }
  catch (err) {
    if (!(err instanceof Error) || err instanceof Exit)
      throw err

    const cause = err.cause instanceof Error ? `\n  caused by: ${sanitizePgErrorMessage(err.cause.message)}` : ''

    return fail(`${err.name}: ${err.message}${cause}`, 1)
  }
  finally {
    await cfg.db.close()
  }
}

const version = ((await Bun.file(new URL('../package.json', import.meta.url)).json()) as { version: string }).version

process.exitCode = await runCli({
  name: 'pg-orm',
  version,
  about: 'migrations for @kaynooo/pg-orm',
  commands: {
    status: {
      summary: 'show schema drift, pending files and applied files changed since',
      async run(args) {
        const parsed = parse(args, 'usage: pg-orm status [options]', { check: { type: 'boolean', description: 'exit 1 on schema drift, a pending file or an applied file changed since' }, raw: RAW })

        return parsed ? withConfig(parsed.values.raw, cfg => cmdStatus(cfg, parsed.values.check === true)) : 0
      },
    },
    generate: {
      summary: 'generate a migration file from current drift',
      async run(args) {
        const parsed = parse(args, 'usage: pg-orm generate [options]', { 'allow-destructive': ALLOW_DESTRUCTIVE, 'dry-run': { ...DRY_RUN, description: 'print the migration instead of writing its file' }, 'raw': RAW })

        return parsed ? withConfig(parsed.values.raw, cfg => cmdGenerate(cfg, { allowDestructive: parsed.values['allow-destructive'], dryRun: parsed.values['dry-run'] })) : 0
      },
    },
    new: {
      summary: 'create an empty migration file',
      async run(args) {
        const parsed = parse(args, 'usage: pg-orm new [name] [options]', { raw: RAW })

        return parsed ? withConfig(parsed.values.raw, cfg => cmdNew(cfg.migrationsDir, parsed.positionals[0] ?? '')) : 0
      },
    },
    apply: {
      summary: 'apply pending migration files to the database',
      async run(args) {
        const parsed = parse(args, 'usage: pg-orm apply [options]', { 'dry-run': { ...DRY_RUN, description: 'list the pending files without applying them' }, 'raw': RAW })

        return parsed ? withConfig(parsed.values.raw, cfg => cmdApply(cfg.db, cfg.migrationsDir, parsed.values['dry-run'] === true)) : 0
      },
    },
    rollback: {
      summary: 'roll back the last N applied migrations (default: 1)',
      async run(args) {
        const parsed = parse(args, 'usage: pg-orm rollback [n] [options]', { raw: RAW })

        if (!parsed)
          return 0

        const [arg] = parsed.positionals

        if (arg !== undefined && !COUNT_RE.test(arg))
          badUsage(`rollback takes a positive whole count, got "${arg}"`)

        return withConfig(parsed.values.raw, cfg => cmdRollback(cfg.db, arg === undefined ? 1 : Number(arg)))
      },
    },
    sync: {
      summary: 'generate, apply and record a migration, then write its file',
      async run(args) {
        const parsed = parse(args, 'usage: pg-orm sync [options]', { 'allow-destructive': ALLOW_DESTRUCTIVE, 'dry-run': { ...DRY_RUN, description: 'print the migration without applying it or writing its file' }, 'raw': RAW })

        return parsed ? withConfig(parsed.values.raw, cfg => cmdSync(cfg, { allowDestructive: parsed.values['allow-destructive'], dryRun: parsed.values['dry-run'] })) : 0
      },
    },
  },
})
