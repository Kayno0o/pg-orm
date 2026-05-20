# Changelog

## Unreleased

### Internal — Phase A architecture decomposition

- Extracted bun:sql interop into `src/sql/adapter.ts` (`BunSqlDriver`, `asDriver()`, `serializePgArray`, `serializeParams`, `normalizeRows`, `unsafeQuery`) — replaces the 8 inline `as unknown as { begin/savepoint/close/unsafe }` cast sites in `executor.ts`.
- Extracted process-exit cleanup into `src/sql/cleanup.ts` (`registerInstance`, `unregisterInstance`).
- Extracted TTY confirmation prompt into `src/migration/interactive.ts`.
- Extracted `Database.sync()` / `Database.rollback()` bodies into standalone `syncSchema()` / `rollbackMigrations()` under `src/migration/sync.ts` and `src/migration/rollback.ts`; `Database` methods are now 3-line delegates.
- Extracted migration history helpers into `src/migration/history.ts`.
- Extracted Repository helpers: `HookOrchestrator` (`src/repo/hooks.ts`), virtuals (`src/repo/virtuals.ts`), trait accessors (`src/repo/traits.ts`).
- `HookOrchestrator.runBeforeMany()` replaces inline `hasHooks + Promise.all + runHooksAsync` patterns in `insertMany` / `upsertMany`, eliminating a real divergence from `insertOne`.
- Split `migration/diff.ts` (543L) into per-entity differs under `src/migration/diff/`: `enums.ts`, `tables.ts`, `columns.ts`, `foreign-keys.ts`, `indexes.ts`. Top-level `diffSchema()` is now a thin orchestrator.
- `sql/executor.ts` shrank 973 → 614 lines (-37%). `repo/index.ts` shrank 783 → 668 lines.

### Type-safety hardening

- Added `phantom<T>()` helper in `src/types/index.ts`. Replaces inline `undefined as unknown as T` patterns in `schema/columns.ts`.
- Dropped unnecessary `as unknown as ...` casts in `src/builder/expr.ts` comparison/in/notIn ops — the singleton's `ExprBuilder<any>` already permits `string | ExprTape`, so casts were noise.
- Enabled `noUnusedLocals` and `noUnusedParameters` in `tsconfig.json`. Cleaned up unused parameters in `MergeBuilder.whenMatched`/`whenNotMatched` (prefixed `_action`) and `SelectBuilder.include` (`_table`).

### Security & correctness

- **Isolation level / access mode**: replaced `SET TRANSACTION ISOLATION LEVEL ${opts.isolation.toUpperCase()}` with a static lookup table (`ISOLATION_SQL`, `ACCESS_MODE_SQL`). SQL is now composed only from fixed strings, eliminating any future injection risk through this codepath.
- **Statement timeout**: rewrote `SET statement_timeout = ${n}` as `SELECT set_config('statement_timeout', $1, true)` — now uses bound parameters instead of literal interpolation.
- Added `quoteLiteral(val)` and `escapeLiteralBody(val)` to `src/sql/utils.ts`. Replaced inline `.replace(SINGLE_QUOTE_RE, "''")` patterns in `migration/ddl.ts`, `migration/diff/enums.ts`, and `schema/columns.ts:toSQLDefault`.
- **Cycle-before-depth**: `RelationLoader.loadIncludes` now checks circular-include detection before the depth limit. Yields the more informative diagnostic on cyclic graphs.
- **Trait double-application guard** (*breaking for custom traits*): `Trait` interface now accepts an optional `name: string`. Built-in `softDelete`, `optimisticLock`, `timestamps` set names; `applyTrait` throws `OrmError` if a named trait is re-applied to the same table. Tracked in `table.meta._appliedTraits`.

## v3.0.0

### Breaking Changes

- **Requires Bun with `bun:sql` support** — removed `pg` driver dependency
- Schema definition API rewritten — `defineTable()` replaces previous schema builder
- Repository API now uses callback-style query building: `repo.findMany(q => q.where(...))`
- Expression builder uses tape-based compilation (new `ExprBuilder` interface)
- Error classes restructured — all extend `OrmError` with typed subclasses

### Features

- **Type-safe schema** — phantom types for compile-time safety with zero runtime cost
- **JIT-compiled mappers** — row-to-object mapping compiled at schema definition time
- **Tape-based expression compiler** — minimal allocations, flat instruction array
- **Trait system** — composable behaviors: `softDelete()`, `timestamps()`, `optimisticLock()`
- **Batched relation loading** — `include()` with no N+1 queries, chunked for large ID sets
- **Cursor-based pagination** — `paginateCursor()` for efficient large dataset traversal
- **MERGE support** — `MergeBuilder` for PostgreSQL 15+ MERGE statements
- **Set operations** — `UNION`, `INTERSECT`, `EXCEPT` via `SetOperationBuilder`
- **CTE support** — `WITH` and `WITH RECURSIVE` via `.with()` / `.withRecursive()`
- **Window functions** — `.window()` with `PARTITION BY` and `ORDER BY`
- **Aggregate builder** — `.aggregate()` with type-safe aggregate expressions
- **JSONB operators** — `jsonbPath()`, `jsonbSubscript()` for JSONB querying
- **Full-text search** — `tsMatch()`, `tsQuery()` with language configuration
- **pgvector support** — `vectorCosineDistance()`, `vectorL2Distance()`, `vectorInnerProduct()`
- **Array operators** — `arrayContains()`, `arrayOverlap()` for PG array columns
- **Row-level locking** — `forUpdate()`, `forShare()`, `skipLocked()`
- **Streaming** — async iterator with chunked fetching via `repo.stream()`
- **Hooks** — `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`, `afterSelect`
- **Auto-migration** — `db.sync()` introspects live DB and applies DDL diffs
- **Destructive migration protection** — requires explicit `allowDestructive: true`
- **Enum diffing** — create, add values, remove values (via type recreation)
- **Query logging** — `onQuery` and `onSlowQuery` callbacks
- **Statement timeout** — per-connection `statementTimeout` option
- **Typed error taxonomy** — PG error codes mapped to `UniqueError`, `ForeignKeyError`, `NotNullError`, `CheckError`, `ConnectionError`, `TimeoutError`
- **Production-safe errors** — query redaction in production, sanitized error messages
- **Transaction support** — with savepoints, isolation levels, and access modes
- **Virtual fields** — computed properties with lazy getter evaluation
- **Relation filtering** — `.include('posts', sq => sq.where(...))`

### Internal

- Zero circular dependencies (verified by madge)
- 1 runtime dependency (`@kaynooo/utils`)
- ESM output with source maps, tree-shakeable
- TypeDoc generation configured
