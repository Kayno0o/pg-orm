import type { SQL } from 'bun'
import type { SQLQueryBindings, Statement } from 'bun:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database as SqliteDatabase } from 'bun:sqlite'
import { ConnectionError, DialectError, MigrationError, ValidationError } from '../errors/index'
import { isJsonParam } from './json-param'
import { toSqliteText } from './sqlite-text'

// How long a write waits for another connection holding the file's lock before SQLITE_BUSY.
const BUSY_TIMEOUT_MS = 5000
const BUSY_MAX_DELAY_MS = 50
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const STATEMENT_CACHE_MAX = 500

const MEMORY_FILENAMES = new Set([':memory:', ''])

/** The surface the executors drive, the one `asDriver` reads off a Bun `SQL` instance. */
interface SqliteHandle {
  unsafe: (sql: string, params: unknown[]) => Promise<unknown[]>
  begin: <T>(fn: (tx: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>
  savepoint: <T>(fn: (sp: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>
  close: (opts?: { timeout?: number }) => Promise<void>
}

// SQLite binds strings, numbers, bigints, blobs and null: a Date goes in as its ISO string, which sorts and compares in time order, and a JSON value or array as its JSON text.
function toBinding(value: unknown): SQLQueryBindings {
  if (value === undefined || value === null)
    return null

  if (isJsonParam(value))
    return JSON.stringify(value.value) ?? null

  if (value instanceof Date)
    return value.toISOString()

  if (typeof value === 'boolean')
    return value ? 1 : 0

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || ArrayBuffer.isView(value))
    return value as SQLQueryBindings

  return JSON.stringify(value)
}

function isBusy(err: unknown): boolean {
  return err instanceof Error && (err as { code?: string }).code === 'SQLITE_BUSY'
}

// Integers are read as bigints, so an int8 past 2^53 keeps its precision; one a number holds is handed back as a number, as Postgres hands back an int4.
function narrowIntegers(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const row of rows) {
    for (const key in row) {
      const value = row[key]

      if (typeof value === 'bigint' && value >= MIN_SAFE && value <= MAX_SAFE)
        row[key] = Number(value)
    }
  }

  return rows
}

/**
 * pg-orm's driver for a SQLite file, over `bun:sqlite`: one connection, so a statement waits while a transaction holds it, and one issued from inside the transaction's body runs in it.
 * Foreign keys are enforced and a file database runs in WAL mode, opened on first use, its directory created as needed.
 */
export class SqliteDriver implements SqliteHandle {
  private _db?: SqliteDatabase
  private _closed = false
  private readonly _statements = new Map<string, Statement>()
  private _tail: Promise<void> = Promise.resolve()
  private _queued = 0
  private _savepoints = 0
  // Set for the async scope of a transaction body, whose statements skip the queue it holds.
  private readonly _inTransaction = new AsyncLocalStorage<true>()

  constructor(readonly filename: string) {}

  async unsafe(sql: string, params: unknown[]): Promise<unknown[]> {
    if (this._inTransaction.getStore())
      return this._run(sql, params)

    if (this._queued === 0)
      return this._waitBusy(() => this._run(sql, params))

    return this._exclusive(async () => this._waitBusy(() => this._run(sql, params)))
  }

  async begin<T>(fn: (tx: InstanceType<typeof SQL>) => Promise<T>): Promise<T> {
    if (this._inTransaction.getStore())
      throw new DialectError('A transaction opened from inside another one (independent: true)', 'sqlite')

    return this._exclusive(() => this._transaction(fn))
  }

  async savepoint<T>(fn: (sp: InstanceType<typeof SQL>) => Promise<T>): Promise<T> {
    if (!this._inTransaction.getStore())
      throw new ValidationError('savepoint() needs a running transaction', 'savepoint')

    const name = `"pgorm_sp_${++this._savepoints}"`

    this._run(`SAVEPOINT ${name}`, [])

    try {
      const result = await fn(this as unknown as InstanceType<typeof SQL>)

      this._run(`RELEASE ${name}`, [])

      return result
    }
    catch (err) {
      this._run(`ROLLBACK TO ${name}`, [])
      this._run(`RELEASE ${name}`, [])

      throw err
    }
  }

  /**
   * Runs `fn` in a transaction with foreign keys off, checked before the commit: a table rebuild drops the table it replaces, which with foreign keys on would cascade into every table referencing it.
   * SQLite ignores the pragma inside a transaction, so it is set around it.
   */
  async migrate<T>(fn: (tx: InstanceType<typeof SQL>) => Promise<T>): Promise<T> {
    if (this._inTransaction.getStore())
      throw new DialectError('A migration (sync, rollback, applyMigration) run from inside a transaction', 'sqlite')

    return this._exclusive(async () => {
      this._run('PRAGMA foreign_keys = OFF', [])

      try {
        return await this._transaction(async (tx) => {
          const result = await fn(tx)
          const violations = this._run('PRAGMA foreign_key_check', []) as { table: string, parent: string }[]

          if (violations.length > 0) {
            const tables = [...new Set(violations.map(v => `"${v.table}" -> "${v.parent}"`))].join(', ')

            throw new MigrationError(`Migration leaves rows breaking a foreign key: ${tables}`, 'apply')
          }

          return result
        })
      }
      finally {
        this._run('PRAGMA foreign_keys = ON', [])
      }
    })
  }

  async close(): Promise<void> {
    await this._tail

    for (const statement of this._statements.values())
      statement.finalize()

    this._statements.clear()
    this._db?.close()
    this._db = undefined
    this._closed = true
  }

  private async _transaction<T>(fn: (tx: InstanceType<typeof SQL>) => Promise<T>): Promise<T> {
    // IMMEDIATE takes the write lock up front: a deferred transaction that reads, then writes, fails with SQLITE_BUSY when another process wrote in between, which no busy timeout can wait out.
    await this._waitBusy(() => this._run('BEGIN IMMEDIATE', []))

    try {
      const result = await this._inTransaction.run(true, () => fn(this as unknown as InstanceType<typeof SQL>))

      this._run('COMMIT', [])

      return result
    }
    catch (err) {
      // A failed COMMIT (a deferred foreign key) leaves the transaction open.
      if (this._open().inTransaction)
        this._run('ROLLBACK', [])

      throw err
    }
  }

  private async _exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this._tail
    let release!: () => void

    this._tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this._queued++

    try {
      await previous

      return await fn()
    }
    finally {
      this._queued--
      release()
    }
  }

  // bun:sqlite waits on a lock by blocking the thread, which would also stall this process's own transaction holding it, so SQLITE_BUSY is waited out here, between event loop turns.
  private async _waitBusy<T>(fn: () => T): Promise<T> {
    const deadline = Date.now() + BUSY_TIMEOUT_MS

    for (let delay = 1; ; delay = Math.min(delay * 2, BUSY_MAX_DELAY_MS)) {
      try {
        return fn()
      }
      catch (err) {
        if (!isBusy(err) || Date.now() >= deadline)
          throw err

        await Bun.sleep(delay)
      }
    }
  }

  private _run(sql: string, params: unknown[]): unknown[] {
    const { text, statements } = toSqliteText(sql)
    const db = this._open()

    // A migration whose down SQL is only `-- Cannot reverse` comments has nothing to run, which prepare() would refuse.
    if (statements === 0)
      return []

    if (statements > 1) {
      if (params.length > 0)
        throw new ValidationError('Several statements cannot share parameters: send them one at a time', 'query', { value: sql })

      db.run(text)

      return []
    }

    return narrowIntegers(this._statement(db, text).all(...params.map(toBinding)) as Record<string, unknown>[])
  }

  // Compiled statements are kept per SQL text, the least recently used finalized past the cap, where `db.query()` would cache every IN-list length forever.
  private _statement(db: SqliteDatabase, text: string): Statement {
    const cached = this._statements.get(text)

    if (cached) {
      this._statements.delete(text)
      this._statements.set(text, cached)

      return cached
    }

    const statement = db.prepare(text)

    this._statements.set(text, statement)

    if (this._statements.size > STATEMENT_CACHE_MAX) {
      const [oldest, evicted] = this._statements.entries().next().value!

      this._statements.delete(oldest)
      evicted.finalize()
    }

    return statement
  }

  private _open(): SqliteDatabase {
    if (this._db)
      return this._db

    if (this._closed)
      throw new ConnectionError('Database is closed')

    const memory = MEMORY_FILENAMES.has(this.filename)

    if (!memory)
      mkdirSync(dirname(this.filename), { recursive: true })

    const db = new SqliteDatabase(this.filename, { create: true, safeIntegers: true })

    try {
      db.run('PRAGMA foreign_keys = ON')

      if (!memory)
        db.run('PRAGMA journal_mode = WAL')
    }
    catch (err) {
      db.close()

      throw err
    }

    this._db = db

    return db
  }
}
