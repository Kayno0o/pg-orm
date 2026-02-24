# Changelog

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
