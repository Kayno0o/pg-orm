import type { Database, Executable, SavepointClient, TransactionClient } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { RelationResolver as RelationResolverType } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { DEFAULT_BATCH_CHUNK_SIZE, DEFAULT_MAX_INCLUDE_DEPTH } from '../constants'
import { createMapperFactory } from './_mapper'
import { ReadSuite } from './read-suite'
import { RelationResolver } from './relation-resolver'
import { StreamSuite } from './stream-suite'
import { buildTableRuntime } from './table-runtime'
import { WriteSuite } from './write-suite'

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
 * Operations are organized into three suites accessed as properties:
 * - `repo.read` — `findMany`, `findOne`, `findOneOrThrow`, `findById`, `count`,
 *   `exists`, `paginate`, `paginateCursor`, and the `select()` builder.
 * - `repo.write` — `insertOne/Many`, `updateOne/Many`, `updateWithLock`,
 *   `deleteOne/Many`, `upsertOne/Many`, `findOrCreate`, `restore`, `forceDelete`,
 *   and the `insert/update/delete/merge/upsert` builders.
 * - `repo.stream` — `stream` (LIMIT/OFFSET chunked) and `streamCursor` (keyset).
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
  private _table: AnyTableDef
  private _exec: Executable
  private _rt: TableRuntime
  private _rel: RelationResolverType
  private _map: MapperFactory
  private _tableRegistry?: ReadonlyMap<string, AnyTableDef>
  private _maxIncludeDepth: number
  private _batchChunkSize: number
  private _defaultLimit?: number

  /** Read suite — `findMany`, `findOne`, `count`, `paginate*`, `select()`, etc. */
  readonly read: ReadSuite<TColumns, TRelations, TVirtuals>
  /** Write suite — `insert*`, `update*`, `delete*`, `upsert*`, builders, etc. */
  readonly write: WriteSuite<TColumns, TRelations, TVirtuals>
  /** Stream suite — `stream` and `streamCursor`. */
  readonly stream: StreamSuite<TColumns, TRelations, TVirtuals>

  constructor(config: RepositoryConfig) {
    this._table = config.table
    this._exec = config.executor
    this._tableRegistry = config.tableRegistry
    this._maxIncludeDepth = config.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH
    this._batchChunkSize = config.batchChunkSize ?? DEFAULT_BATCH_CHUNK_SIZE
    this._defaultLimit = config.defaultLimit

    this._rt = buildTableRuntime(this._table)
    this._rel = new RelationResolver(this._table, this._exec, this._maxIncludeDepth, this._batchChunkSize, this._tableRegistry)
    this._map = createMapperFactory(this._table)

    this.read = new ReadSuite<TColumns, TRelations, TVirtuals>(this._exec, this._rt, this._rel, this._map, this._defaultLimit, this._tableRegistry)
    this.write = new WriteSuite<TColumns, TRelations, TVirtuals>(this._exec, this._rt)
    this.stream = new StreamSuite<TColumns, TRelations, TVirtuals>(this._exec, this._rt, this._rel, this._map, this._tableRegistry)
  }

  /**
   * Rebind this repository to a transaction or savepoint client. Returns a new
   * `Repository` instance sharing the same table/config but routed through the
   * supplied executor. Useful inside `db.transaction(...)`:
   *
   * @example
   * ```ts
   * await db.transaction(async (tx) => {
   *   const row = await repo.using(tx).write.insertOne({ … })
   * })
   * ```
   */
  using(tx: TransactionClient | SavepointClient | Database): Repository<TColumns, TRelations, TVirtuals> {
    return new Repository<TColumns, TRelations, TVirtuals>({
      table: this._table,
      executor: tx as Executable,
      tableRegistry: this._tableRegistry,
      maxIncludeDepth: this._maxIncludeDepth,
      defaultLimit: this._defaultLimit,
      batchChunkSize: this._batchChunkSize,
    })
  }
}
