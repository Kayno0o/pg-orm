import type { SQL } from 'bun'
import type { SQLQueryBindings, Statement } from 'bun:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database as SqliteDatabase } from 'bun:sqlite'
import { ConnectionError, DialectError, MigrationError, ValidationError } from '../errors/index'
import { arrayElementAsJson, bigintAsString, isJsonParam } from '../utils/json-param'
import { toSqliteText } from './sqlite-text'

// How long a write waits for another connection holding the file's lock before SQLITE_BUSY.
const BUSY_TIMEOUT_MS = 5000
const BUSY_MAX_DELAY_MS = 50
const SQLITE_BUSY = 5
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const STATEMENT_CACHE_MAX = 500
// A multi-row insert prints one text per row count, each compiled statement holding megabytes: past this length it is finalized after its run instead of kept.
const STATEMENT_CACHE_MAX_LENGTH = 8192

const MEMORY_FILENAMES = new Set([':memory:', ''])
const READ_ONLY_RE = /\bREAD ONLY\b/

/** The surface the executors drive, the one `asDriver` reads off a Bun `SQL` instance. */
interface SqliteHandle {
  unsafe: (sql: string, params: unknown[]) => Promise<unknown[]>
  begin: <T>(optionsOrFn: string | ((tx: InstanceType<typeof SQL>) => Promise<T>), fn?: (tx: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>
  savepoint: <T>(fn: (sp: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>
  close: (opts?: { timeout?: number }) => Promise<void>
}

// SQLite binds strings, numbers, bigints, blobs and null: a Date goes in as its ISO string, which sorts and compares in time order, and a JSON value or array as its JSON text.
function toBinding(value: unknown): SQLQueryBindings {
  if (value === undefined || value === null)
    return null

  if (isJsonParam(value))
    return JSON.stringify(value.value, bigintAsString) ?? null

  if (value instanceof Date)
    return value.toISOString()

  if (typeof value === 'boolean')
    return value ? 1 : 0

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || ArrayBuffer.isView(value))
    return value as SQLQueryBindings

  return JSON.stringify(value, arrayElementAsJson)
}

async function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([work, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    })])
  }
  finally {
    clearTimeout(timer)
  }
}

// Primary result code 5: bun:sqlite reports extended codes such as SQLITE_BUSY_RECOVERY (261), each waited out like SQLITE_BUSY. SQLITE_BUSY_SNAPSHOT is too, as `_waitBusy` only ever retries a statement outside a transaction.
function isBusy(err: unknown): boolean {
  const errno = err instanceof Error ? (err as { errno?: unknown }).errno : undefined

  return typeof errno === 'number' && (errno & 0xFF) === SQLITE_BUSY
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
/** How a SQLite file syncs to disk: `normal` under WAL can lose the last commits to a power cut, never to a process crash, and never corrupts the file; `full` syncs every commit. */
export type SqliteSynchronous = 'normal' | 'full'

export class SqliteDriver implements SqliteHandle {
  private _db?: SqliteDatabase
  private _closed = false
  // Keyed by the SQL as pg-orm prints it, so a cached statement skips the `$N` to `?N` rewrite too.
  private readonly _statements = new Map<string, Statement>()
  private _tail: Promise<void> = Promise.resolve()
  private _queued = 0
  private _savepoints = 0
  // Set for the async scope of a transaction body, whose statements skip the queue it holds; `open` clears at its end, so work the body started that outlives it queues like any other.
  private readonly _transactionScope = new AsyncLocalStorage<{ open: boolean }>()

  constructor(readonly filename: string, private readonly _synchronous: SqliteSynchronous = 'normal') {}

  async unsafe(sql: string, params: unknown[]): Promise<unknown[]> {
    if (this._inTransaction())
      return this._run(sql, params)

    // Only a statement that runs at once skips the queue: one waiting out SQLITE_BUSY there would wake inside a transaction begun meanwhile and commit or roll back with it.
    if (this._queued === 0) {
      try {
        return this._run(sql, params)
      }
      catch (err) {
        if (!isBusy(err))
          throw err
      }
    }

    return this._exclusive(async () => this._waitBusy(() => this._run(sql, params)))
  }

  // `options` are the transaction modes Postgres would take on BEGIN: a read-only one begins DEFERRED, leaving the file's write lock to other processes.
  async begin<T>(optionsOrFn: string | ((tx: InstanceType<typeof SQL>) => Promise<T>), maybeFn?: (tx: InstanceType<typeof SQL>) => Promise<T>): Promise<T> {
    if (this._inTransaction())
      throw new DialectError('A transaction opened from inside another one (independent: true)', 'sqlite')

    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!
    const readOnly = typeof optionsOrFn === 'string' && READ_ONLY_RE.test(optionsOrFn)

    return this._exclusive(() => this._transaction(fn, readOnly ? 'DEFERRED' : 'IMMEDIATE'))
  }

  async savepoint<T>(fn: (sp: InstanceType<typeof SQL>) => Promise<T>): Promise<T> {
    if (!this._inTransaction())
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
    if (this._inTransaction())
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

  // Waits for the queued work as a Bun SQL pool does: `timeout` (seconds) bounds the wait, 0 closes at once, and work still running then fails with ConnectionError.
  async close(opts?: { timeout?: number }): Promise<void> {
    if (opts?.timeout === undefined)
      await this._tail
    else if (opts.timeout > 0)
      await settledWithin(this._tail, opts.timeout * 1000)

    for (const statement of this._statements.values())
      statement.finalize()

    this._statements.clear()
    this._db?.close()
    this._db = undefined
    this._closed = true
  }

  private async _transaction<T>(fn: (tx: InstanceType<typeof SQL>) => Promise<T>, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE'): Promise<T> {
    // IMMEDIATE takes the write lock up front: a deferred transaction that reads, then writes, fails with SQLITE_BUSY when another process wrote in between, which no busy timeout can wait out. Only a read-only one, which never writes, begins DEFERRED.
    await this._waitBusy(() => this._run(`BEGIN ${mode}`, []))

    const scope = { open: true }

    try {
      const result = await this._transactionScope.run(scope, () => fn(this as unknown as InstanceType<typeof SQL>))

      this._run('COMMIT', [])

      return result
    }
    catch (err) {
      // A failed COMMIT (a deferred foreign key) leaves the transaction open.
      if (this._open().inTransaction)
        this._run('ROLLBACK', [])

      throw err
    }
    finally {
      scope.open = false
    }
  }

  private _inTransaction(): boolean {
    return this._transactionScope.getStore()?.open === true
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
      // Opening sets WAL mode, which answers SQLITE_BUSY while another process is opening the same file.
      await this._waitBusy(() => this._open())

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
    const db = this._open()
    const cached = this._statements.get(sql)

    if (cached) {
      this._statements.delete(sql)
      this._statements.set(sql, cached)

      return narrowIntegers(cached.all(...params.map(toBinding)) as Record<string, unknown>[])
    }

    const { text, statements } = toSqliteText(sql)

    // A migration whose down SQL is only `-- Cannot reverse` comments has nothing to run, which prepare() would refuse.
    if (statements === 0)
      return []

    if (statements > 1) {
      if (params.length > 0)
        throw new ValidationError('Several statements cannot share parameters: send them one at a time', 'query', { value: sql })

      db.run(text)

      return []
    }

    const statement = db.prepare(text)

    if (sql.length > STATEMENT_CACHE_MAX_LENGTH) {
      try {
        return narrowIntegers(statement.all(...params.map(toBinding)) as Record<string, unknown>[])
      }
      finally {
        statement.finalize()
      }
    }

    this._keep(sql, statement)

    return narrowIntegers(statement.all(...params.map(toBinding)) as Record<string, unknown>[])
  }

  // Compiled statements are kept per SQL text, the least recently used finalized past the cap, where `db.query()` would cache every IN-list length forever.
  private _keep(sql: string, statement: Statement): void {
    this._statements.set(sql, statement)

    if (this._statements.size > STATEMENT_CACHE_MAX) {
      const [oldest, evicted] = this._statements.entries().next().value!

      this._statements.delete(oldest)
      evicted.finalize()
    }
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

      if (!memory) {
        db.run('PRAGMA journal_mode = WAL')
        db.run(`PRAGMA synchronous = ${this._synchronous === 'full' ? 'FULL' : 'NORMAL'}`)
      }
    }
    catch (err) {
      db.close()

      throw err
    }

    this._db = db

    return db
  }
}
