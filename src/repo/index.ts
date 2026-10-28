import type { Database, Executable, TransactionClient } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, HookContext, TableDef } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { RelationResolver as RelationResolverType } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { DEFAULT_BATCH_CHUNK_SIZE, DEFAULT_MAX_INCLUDE_DEPTH, DEFAULT_MAX_PAGE_SIZE } from '../constants'
import { dialectOf } from '../dialect'
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
  maxPageSize?: number
  batchChunkSize?: number
  /** @internal */
  shared?: { runtime: TableRuntime, mappers: MapperFactory }
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
 * - `repo.stream` - `offset` (LIMIT/OFFSET chunked) and `cursor` (keyset).
 *
 * Create via `db.repo(table)` — the repository inherits the database connection
 * and table registry for relation resolution.
 *
 * @example
 * ```ts
 * const UserRepo = db.repo(users)
 * const alice = await UserRepo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
 * const all = await UserRepo.read.findMany(q => q.where(e => e.eq('status', 'active')))
 * for await (const u of UserRepo.stream.cursor()) console.log(u)
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
  private _maxPageSize: number
  // One rebound repository per transaction client, so `repo.using(tx)` in a loop does not rebuild the runtime, resolver and mapper each time.
  private _boundCache = new WeakMap<object, Repository<TColumns, TRelations, TVirtuals>>()
  // The repositories hooks reach through `ctx.repo(table)`, on this one's executor, rebuilt when the table def is mutated.
  private _hookRepos = new WeakMap<AnyTableDef, { version: number, repo: Repository<AnyColumns, AnyRelations, AnyVirtuals> }>()

  /** Read suite — `findMany`, `findOne`, `count`, `paginate*`, `select()`, etc. */
  readonly read: ReadSuite<TColumns, TRelations, TVirtuals>
  /** Write suite — `insert*`, `update*`, `delete*`, `upsert*`, builders, etc. */
  readonly write: WriteSuite<TColumns, TRelations, TVirtuals>
  /** Stream suite: `offset` and `cursor`. */
  readonly stream: StreamSuite<TColumns, TRelations, TVirtuals>

  constructor(config: RepositoryConfig) {
    this._table = config.table
    this._exec = config.executor
    this._tableRegistry = config.tableRegistry
    this._maxIncludeDepth = config.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH
    this._batchChunkSize = config.batchChunkSize ?? DEFAULT_BATCH_CHUNK_SIZE
    this._defaultLimit = config.defaultLimit
    this._maxPageSize = config.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE

    this._rt = config.shared?.runtime ?? buildTableRuntime(this._table)
    this._rel = new RelationResolver(this._table, this._exec, this._maxIncludeDepth, this._batchChunkSize, this._tableRegistry)
    this._map = config.shared?.mappers ?? createMapperFactory(this._table, dialectOf(this._exec))

    const hooks: HookContext = { repo: table => this._hookRepo(table) }

    this.read = new ReadSuite<TColumns, TRelations, TVirtuals>(this._exec, this._rt, this._rel, this._map, this._defaultLimit, this._tableRegistry, this._maxPageSize, hooks)
    this.write = new WriteSuite<TColumns, TRelations, TVirtuals>(this._exec, this._rt, hooks, this._tableRegistry)
    this.stream = new StreamSuite<TColumns, TRelations, TVirtuals>(this._exec, this._rt, this._rel, this._map, this._tableRegistry, hooks)
  }

  private _hookRepo<C extends AnyColumns, R extends AnyRelations, V extends AnyVirtuals>(table: TableDef<string, C, R, V>): Repository<C, R, V> {
    const def = table as AnyTableDef

    if (def === this._table)
      return this as unknown as Repository<C, R, V>

    const cached = this._hookRepos.get(def)

    if (cached && cached.version === def._version)
      return cached.repo as unknown as Repository<C, R, V>

    const repo = new Repository<AnyColumns, AnyRelations, AnyVirtuals>({
      table: def,
      executor: this._exec,
      tableRegistry: this._tableRegistry,
      maxIncludeDepth: this._maxIncludeDepth,
      defaultLimit: this._defaultLimit,
      maxPageSize: this._maxPageSize,
      batchChunkSize: this._batchChunkSize,
    })

    this._hookRepos.set(def, { version: def._version, repo })

    return repo as unknown as Repository<C, R, V>
  }

  /** The table definition this repository reads and writes, typed for generic code: `isColumn(repo.table, name)`, `whereColumn(repo.table, name, value)`. */
  get table(): TableDef<string, TColumns, TRelations, TVirtuals> {
    return this._table as TableDef<string, TColumns, TRelations, TVirtuals>
  }

  /**
   * Rebind this repository to a transaction client. Returns a new
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
  using(tx: TransactionClient | Database): Repository<TColumns, TRelations, TVirtuals> {
    const cached = this._boundCache.get(tx)

    if (cached)
      return cached as Repository<TColumns, TRelations, TVirtuals>

    const bound = new Repository<TColumns, TRelations, TVirtuals>({
      table: this._table,
      executor: tx as Executable,
      tableRegistry: this._tableRegistry,
      maxIncludeDepth: this._maxIncludeDepth,
      defaultLimit: this._defaultLimit,
      maxPageSize: this._maxPageSize,
      batchChunkSize: this._batchChunkSize,
      // The mappers coerce per dialect, so another database's repository builds its own.
      shared: dialectOf(tx as Executable) === dialectOf(this._exec) ? { runtime: this._rt, mappers: this._map } : undefined,
    })

    this._boundCache.set(tx, bound)

    return bound
  }
}
