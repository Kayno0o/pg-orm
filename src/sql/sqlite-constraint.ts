import { quote } from '../utils/quote'

type Unsafe = (sqlStr: string, params: unknown[]) => Promise<unknown[]>

interface IndexRow { name: string, unique: number, origin: string }

const NAMED_UNIQUE_RE = /CONSTRAINT\s+("(?:[^"]|"")+"|\w+)\s+UNIQUE\s*\(([^)]*)\)/gi

function unquote(identifier: string): string {
  const trimmed = identifier.trim()

  return trimmed.startsWith('"') ? trimmed.slice(1, -1).replaceAll('""', '"') : trimmed
}

// A CONSTRAINT name only survives in the table's DDL: the unique index SQLite builds for it is called `sqlite_autoindex_*`.
async function declaredConstraintName(unsafe: Unsafe, table: string, columns: string[]): Promise<string | undefined> {
  const [row] = await unsafe('SELECT "sql" FROM "sqlite_master" WHERE "type" = \'table\' AND "name" = ?', [table]) as { sql: string | null }[]

  for (const [, name, listed] of (row?.sql ?? '').matchAll(NAMED_UNIQUE_RE)) {
    if (listed!.split(',').map(unquote).join() === columns.join())
      return unquote(name!)
  }

  return undefined
}

/**
 * The name Postgres reports for the UNIQUE constraint or unique index over `columns` that SQLite failed on, which its message leaves out: an index created with CREATE UNIQUE INDEX, or a constraint named in the table's DDL.
 * `undefined` when it has no name of its own (the caller falls back to the default `<table>_<columns>_key`) or the schema cannot be read.
 */
export async function sqliteUniqueName(unsafe: Unsafe, table: string, columns: string[]): Promise<string | undefined> {
  try {
    for (const index of await unsafe(`PRAGMA index_list(${quote(table)})`, []) as IndexRow[]) {
      if (!index.unique)
        continue

      const indexed = await unsafe(`PRAGMA index_info(${quote(index.name)})`, []) as { name: string | null }[]

      if (indexed.map(column => column.name).join() !== columns.join())
        continue

      return index.origin === 'c' ? index.name : await declaredConstraintName(unsafe, table, columns)
    }
  }
  catch {
    // naming the constraint is a courtesy: the failure itself is what gets reported
  }

  return undefined
}
