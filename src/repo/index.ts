import type { SelectBuilder } from '../builder/query'
import type { Database, Executable, SavepointClient, TransactionClient } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals } from '../types/index'
import type { RepositoryCtx } from './context'
import { DEFAULT_BATCH_CHUNK_SIZE, DEFAULT_MAX_INCLUDE_DEPTH, DEFAULT_PRIMARY_KEY } from '../constants'
import { getOrCompileMapper } from '../mapper/index'
import { HookOrchestrator } from './hooks'
import { TraitDispatcher } from './middleware'
import { ReadSuite } from './read-suite'
import { RelationLoader } from './relation-loader'
import { StreamSuite } from './stream-suite'
import { clearVirtualEntriesCache, VirtualEntriesCache } from './virtuals'
import { WriteSuite } from './write-suite'

export { clearVirtualEntriesCache }

/**
 * Construction params for `Repository`. Only `table` and `executor` are required;
 * everything else falls back to module defaults. Built by `Database.repo()` — most
 * callers should not construct `Repository` directly.
 */
export interface RepositoryConfig {
  table: AnyTableDef
  executor: Executable
  tableRegistry?: ReadonlyMap<string, AnyTableDef>
  maxIncludeDepth?: number
  defaultLimit?: number
  batchChunkSize?: number
}

/**
 * Type-safe repository for a table definition.
 *
 * Operations are organized into three lazy suites accessed as properties:
 * - `repo.read` — `findMany`, `findOne`, `findOneOrThrow`, `findById`, `count`,
 *   `exists`, `paginate`, `paginateCursor`, and the `select()` builder.
 * - `repo.write` — `insertOne/Many`, `updateOne/Many`, `updateWithLock`,
 *   `deleteOne/Many`, `upsertMany`, `findOrCreate`, `restore`, `forceDelete`,
 *   and the `insert/update/delete/merge/upsert` builders.
 * - `repo.stream` — `stream` (LIMIT/OFFSET chunked) and `streamCursor` (keyset).
 *
 * Each suite is constructed on first access; suites you never touch never allocate.
 *
 * Create via `db.repo(table)` — the repository inherits the database connection
 * and table registry for relation resolution.
 *
 * @example
 * ```ts
 * const UserRepo = db.repo(users)
 * const alice = await UserRepo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
 * const all = await UserRepo.read.findMany(q => q.where(e => e.eq('status', 'active')))
 * for await (const u of UserRepo.stream.streamCursor()) console.log(u)
 * ```
 */
export class Repository<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  private _ctx: RepositoryCtx
  private _readSuite?: ReadSuite<TColumns, TRelations, TVirtuals>
  private _writeSuite?: WriteSuite<TColumns, TRelations, TVirtuals>
  private _streamSuite?: StreamSuite<TColumns, TRelations, TVirtuals>

  constructor(config: RepositoryConfig) {
    const table = config.table
    const executor = config.executor
    const maxIncludeDepth = config.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH
    const batchChunkSize = config.batchChunkSize ?? DEFAULT_BATCH_CHUNK_SIZE
    const relationLoader = new RelationLoader(table, executor, maxIncludeDepth, batchChunkSize, config.tableRegistry)
    const hooks = new HookOrchestrator(table)
    const traits = new TraitDispatcher(table)
    const virtualsCache = new VirtualEntriesCache()

    this._ctx = {
      table,
      executor,
      tableRegistry: config.tableRegistry,
      maxIncludeDepth,
      batchChunkSize,
      defaultLimit: config.defaultLimit,
      relationLoader,
      hooks,
      traits,
      virtualsCache,
      getPrimaryKey: () => table.primaryKey ?? DEFAULT_PRIMARY_KEY,
      getMapper: (builder: SelectBuilder<any, any, any>) => {
        const s = builder.getState()

        return getOrCompileMapper(
          table.name,
          table.columns,
          s.columns ?? undefined,
          s.omitColumns.length ? s.omitColumns : undefined,
        )
      },
      query: (sql, params) => executor.query(sql, params),
    }
  }

  /** Read suite — `findMany`, `findOne`, `count`, `paginate*`, `select()`, etc. */
  get read(): ReadSuite<TColumns, TRelations, TVirtuals> {
    return this._readSuite ??= new ReadSuite<TColumns, TRelations, TVirtuals>(this._ctx)
  }

  /** Write suite — `insert*`, `update*`, `delete*`, `upsertMany`, builders, etc. */
  get write(): WriteSuite<TColumns, TRelations, TVirtuals> {
    return this._writeSuite ??= new WriteSuite<TColumns, TRelations, TVirtuals>(this._ctx)
  }

  /** Stream suite — `stream` and `streamCursor`. */
  get stream(): StreamSuite<TColumns, TRelations, TVirtuals> {
    return this._streamSuite ??= new StreamSuite<TColumns, TRelations, TVirtuals>(this._ctx, () => this.read)
  }

  /**
   * Rebind this repository to a transaction or savepoint client. Returns a new
   * `Repository` instance sharing the same table/config but routed through the
   * supplied executor. Useful inside `db.transaction(...)`:
   *
   * @example
   * ```ts
   * await db.transaction(async (tx) => {
   *   const id = await repo.using(tx).write.insertOne({ … })
   * })
   * ```
   */
  using(tx: TransactionClient | SavepointClient | Database): Repository<TColumns, TRelations, TVirtuals> {
    return new Repository<TColumns, TRelations, TVirtuals>({
      table: this._ctx.table,
      executor: tx as Executable,
      tableRegistry: this._ctx.tableRegistry,
      maxIncludeDepth: this._ctx.maxIncludeDepth,
      defaultLimit: this._ctx.defaultLimit,
      batchChunkSize: this._ctx.batchChunkSize,
    })
  }
}
