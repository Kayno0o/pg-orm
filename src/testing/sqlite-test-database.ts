import type { TestDatabase, TestDatabaseOptions } from './options'
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { sqliteFilename } from '../dialect'
import { applyMigrationFiles } from '../migration/files'
import { Database } from '../sql/database'
import { templateName } from './options'

const NOT_IDENTIFIER = /\W+/g
const TEMPLATE_HASH = /^[a-z0-9]+$/
// The files SQLite keeps beside a database in WAL mode.
const SIDE_FILES = ['-wal', '-shm', '-journal']

function removeDatabase(path: string): void {
  for (const suffix of ['', ...SIDE_FILES])
    rmSync(`${path}${suffix}`, { force: true })
}

// Migrated and seeded under a name of its own, then renamed into place: closing the last connection folds the WAL into the file, so the file alone is the whole database.
async function buildTemplate(dir: string, base: string, template: string, options: TestDatabaseOptions): Promise<void> {
  const building = join(dir, `${template}_${crypto.randomUUID().slice(0, 8)}.db`)

  try {
    const db = new Database({ url: `sqlite://${building}`, tables: options.tables })

    try {
      await applyMigrationFiles(db, options.migrationsDir)
      await options.seed?.(db)
    }
    finally {
      await db.close()
    }

    renameSync(building, join(dir, `${template}.db`))
  }
  finally {
    removeDatabase(building)
  }

  const prefix = `${base}_tpl_`

  for (const file of readdirSync(dir)) {
    const name = file.slice(0, -extname(file).length)

    if (extname(file) === '.db' && name.startsWith(prefix) && name !== template && TEMPLATE_HASH.test(name.slice(prefix.length)))
      removeDatabase(join(dir, file))
  }
}

/** `testDatabase` for a SQLite URL: the template and each copy are files next to the app's database, a copy made by copying the file. */
export async function sqliteTestDatabase(options: TestDatabaseOptions): Promise<TestDatabase> {
  const filename = sqliteFilename(options.url)

  if (filename === ':memory:')
    throw new Error('testDatabase: an in-memory SQLite database has no file to copy, give it a path')

  const dir = dirname(filename)
  const base = basename(filename, extname(filename)).replace(NOT_IDENTIFIER, '_') || 'test'
  const template = templateName(base, options)
  const templatePath = join(dir, `${template}.db`)
  const copy = join(dir, `${base}_t${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}.db`)

  if (!existsSync(templatePath))
    await buildTemplate(dir, base, template, options)

  copyFileSync(templatePath, copy)

  return {
    url: `sqlite://${copy}`,
    drop: async () => removeDatabase(copy),
  }
}
