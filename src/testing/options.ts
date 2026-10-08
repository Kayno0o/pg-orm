import type { Database } from '../sql/database'
import type { AnyTableDef } from '../types/index'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface TestDatabaseOptions {
  /** The database the app reads in tests, `DATABASE_URL` in `.env.test`: its server holds the copies, each named after it. It need not exist. A SQLite file's copies sit next to it. */
  url: string
  /** The migration files every copy starts from, applied as `pg-orm apply` applies them. */
  migrationsDir: string
  /** Fills the database once its schema is in, before any copy is made: what every test starts with. */
  seed?: (db: Database) => Promise<void> | void
  /** The tables `seed` reaches through `db.repo(table)`. */
  tables?: AnyTableDef[]
}

export interface TestDatabase {
  /** The copy's connection string: the app's `DATABASE_URL` while the test runs. */
  url: string
  /** Drops the copy, closing what is still connected to it. */
  drop: () => Promise<void>
}

// The template's name changes with every migration file and with the seed, so an edit to either builds a new one rather than reusing one that no longer matches.
export function templateName(base: string, options: TestDatabaseOptions): string {
  // Relative to where the tests run, which is the project's root for `bun test` there.
  if (!existsSync(options.migrationsDir))
    throw new Error(`testDatabase: no migrations folder at ${resolve(options.migrationsDir)}`)

  const files = readdirSync(options.migrationsDir).filter(file => file.endsWith('.sql')).sort()
  const content = files.map(file => `${file}\n${readFileSync(join(options.migrationsDir, file), 'utf8')}`).join('\n')
  const hash = Bun.hash(`${content}\n${options.seed?.toString() ?? ''}`).toString(36).slice(0, 10)

  return `${base}_tpl_${hash}`
}
