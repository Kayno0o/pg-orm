# pg-orm Refactoring Plan

This document tracks architectural-deepening opportunities identified in the codebase. The goal is to replace shallow, tightly-coupled module clusters with **deep modules**: small interfaces that hide large, cohesive implementations.

> Deepening follows the philosophy from John Ousterhout's *A Philosophy of Software Design*: the best modules have a simple interface hiding a complex implementation.

---

## Candidate 1: Repository Write-Operation Pipeline ✅ completed

**Status:** Implemented.

**Cluster (old):**
- `src/repo/ops/insert-one.ts` ❌ deleted
- `src/repo/ops/insert-many.ts` ❌ deleted
- `src/repo/ops/update-many.ts` ❌ deleted
- `src/repo/ops/delete-many.ts` ❌ deleted
- `src/repo/ops/force-delete.ts` ❌ deleted
- `src/repo/ops/restore.ts` ❌ deleted
- `src/repo/ops/upsert.ts` ❌ deleted
- `src/repo/ops/find-or-create.ts` ❌ deleted
- `src/repo/ops/update-with-lock.ts` ❌ deleted
- `src/repo/table-runtime.ts` ✅ kept (runtime boundary)
- `src/repo/write-suite.ts` ✅ rewritten as thin façade

**New deep module:**
- `src/repo/write-pipeline.ts` — owns the full write lifecycle.

**Why they were coupled:**  
Every write-style operation repeated the same ~20-line orchestration:

1. Decide `RETURNING` columns based on `{ full: true }`.
2. Build the appropriate statement builder.
3. Apply pre-execution trait transforms (`applyPreSelect`, `applyPreUpdate`, `rewriteDelete`).
4. Run `before*` hooks.
5. Execute the query.
6. Run `after*` hooks.
7. Apply virtual fields when returning full rows.
8. Extract primary key(s) when returning keys.

The only real variation between ops was the builder type and the hook event names.

**Dependency category:**  
**In-process / local-substitutable.** The pipeline depends on the query builder, `TableRuntime`, and an executor. `tests/helpers/mock-executor.ts` already provides a test stand-in for the executor.

**Outcome:**
- Created `WritePipeline` with a single shared `_execute()` path and one public method per operation (`insertOne`, `insertMany`, `updateMany`, `updateOne`, `updateWithLock`, `deleteMany`, `deleteOne`, `upsertMany`, `findOrCreate`, `restore`, `forceDelete`).
- `WriteSuite` now delegates to `WritePipeline`; it keeps the same typed public API and the raw builder accessors.
- Deleted the nine shallow `src/repo/ops/*.ts` files.
- Updated `tests/unit/repo/ops/{insert,update,delete,upsert-foc}.test.ts` and `_helpers.ts` to test the new `WritePipeline` boundary directly.
- All checks green: `just fix` (circular, typecheck, lint, build) + `bun test tests/unit`.

**What the pipeline hides:**
- Hook selection and timing (`runBefore`/`runBeforeMany`/`runAfter` with correct event names).
- `RETURNING` projection (`[]` for full rows, `[primaryKey]` otherwise).
- Builder construction (`InsertBuilder`, `UpdateBuilder`, `DeleteBuilder`, `OnConflictBuilder`).
- Trait-transform ordering (`applyPreUpdate` strictly after `.set()`; `rewriteDelete` for soft-delete).
- Soft-delete rewrite and `restore()` soft-delete-column guard.
- Empty-array short-circuit for `insertMany`/`upsertMany`.
- Virtual installation and primary-key extraction.

**Public surface preserved:** `repo.write.insertOne(...)` etc. still work exactly as before. Raw builder accessors (`repo.write.insert()`, `repo.write.update()`, etc.) still bypass the pipeline by design.

---

## Candidate 2: Hook, Virtual, and Mapper Post-Processing Pipeline ✅ completed

**Status:** Implemented.

**Cluster (old):**
- `src/repo/ops/find-many.ts` ❌ deleted
- `src/repo/ops/find-one.ts` ❌ deleted
- `src/repo/ops/paginate.ts` ❌ deleted
- `src/repo/ops/stream.ts` ❌ deleted
- `src/repo/ops/stream-cursor.ts` ❌ deleted
- `src/repo/ops/count.ts` ❌ deleted
- `src/repo/ops/exists.ts` ❌ deleted
- `src/repo/ops/_mapper.ts` ✅ moved to `src/repo/_mapper.ts`
- `src/repo/table-runtime.ts` ✅ kept
- `src/repo/relation-resolver.ts` ✅ extended with `RelationProcessor` callback seam
- `src/mapper/index.ts` ✅ unchanged (already a deep module)

**New deep module:**
- `src/repo/read-pipeline.ts` — owns the full read-result lifecycle.

**Why they were coupled:**  
`afterSelect` hooks were open-coded in `findMany`/`stream` instead of going through `runtime.runAfter`. Eager-loaded child rows skipped hooks, virtuals, and mapper coercion entirely. The decision of *when* to map rows, apply virtuals, and run hooks was spread across callers.

**Dependency category:**  
**In-process.** Pure row transformation and hook running.

**Outcome:**
- Created `ReadPipeline` with one shared execution/post-processing path and public methods for `findMany`, `findOne`, `findOneOrThrow`, `findById`, `count`, `exists`, `paginate`, `paginateCursor`, `stream`, and `streamCursor`.
- `ReadSuite` and `StreamSuite` are now thin façades delegating to `ReadPipeline`, mirroring the `WriteSuite`/`WritePipeline` split from Candidate 1.
- Added a `RelationProcessor` callback seam to `RelationResolver` so eager-loaded child rows are recursively post-processed by the pipeline without creating a module cycle.
- Child rows now run through mapper coercion, `afterSelect` hooks, virtual installation, and nested includes — the same lifecycle as top-level rows.
- Deleted the seven shallow read op files and moved `src/repo/ops/_mapper.ts` to `src/repo/_mapper.ts`.
- Updated unit tests to target the `ReadPipeline` boundary directly and added `tests/unit/repo/read-pipeline.test.ts` covering hooks on mapped rows, virtuals on top-level rows, and mapper/hooks/virtuals on eager-loaded child rows.
- All checks green: `just fix` (circular, typecheck, lint, build) + `bun test tests/unit` (911 tests).

**What the pipeline hides:**
- Soft-delete pre-filter application.
- Computed-only query detection (skip JIT mapper).
- JIT mapper coercion for top-level and child rows.
- `afterSelect` hook orchestration through `runtime.runAfter`.
- Virtual installation.
- Eager include loading with recursive child post-processing.
- `stream` LIMIT/OFFSET chunking and unsafe warning.
- `streamCursor` keyset pagination loop.

**Public surface preserved:** `repo.read.findMany(...)` etc. and `repo.stream.stream(...)` still work exactly as before. The builder accessors `repo.read.select()` and the raw query builders still bypass the pipeline by design.

---

## Candidate 3: Trait Middleware / Table-Behavior Pipeline ✅ completed

**Status:** Implemented.

**Cluster (old):**
- `src/repo/table-runtime.ts` ✅ rewritten (delegates trait behavior)
- `src/repo/write-pipeline.ts` ✅ rewritten (delegates to behavior)
- `src/repo/read-pipeline.ts` ✅ rewritten (delegates to behavior)
- `src/traits/index.ts` ✅ unchanged (still declares metadata; behavior interprets it)

**New deep module:**
- `src/repo/table-behavior.ts` — owns the per-table, per-operation trait lifecycle.

**Why they were coupled:**  
Callers had to know the ordering contract for trait rules:

- `applyPreSelect` had to run before `toSQL`.
- `applyPreUpdate` had to run *after* `.set()` so it could inject `setRaw`.
- `restore()` open-coded the soft-delete-column guard and builder construction.
- `updateWithLock` reached into `runtime.optimisticLockColumn` to build its where predicate.

The runtime knew *that* a trait existed, but the pipelines still knew *when* to apply it.

**Dependency category:**  
**In-process.** Trait rules are pure table-state transformations.

**Outcome:**
- Created `TableBehavior` with operation-scoped methods: `prepareSelect`, `prepareInsert`, `prepareUpdate`, `rewriteDelete`, `buildRestoreUpdate`, `getOptimisticLockColumn`, `getSoftDeleteColumn`.
- `TableRuntime` now exposes a single `behavior: TableBehavior` property and dropped `applyPreSelect`, `applyPreUpdate`, `rewriteDelete`, `hasSoftDelete`, `hasOptimisticLock`, `softDeleteColumn`, `optimisticLockColumn`, and `requireSoftDeleteColumn`.
- `WritePipeline` delegates all trait-specific builder preparation to `runtime.behavior`.
  - `updateMany` calls `behavior.prepareUpdate(builder, s)` after `.set()` / `.where()`.
  - `deleteMany` uses `behavior.rewriteDelete(where) ?? DeleteBuilder`.
  - `restore()` uses `behavior.buildRestoreUpdate(s, where)` and no longer open-codes the soft-delete guard or post-set transforms.
  - `updateWithLock()` uses `behavior.getOptimisticLockColumn()` for its version predicate.
- `ReadPipeline` calls `behavior.prepareSelect(builder)` instead of `runtime.applyPreSelect(builder)`.
- Added `tests/unit/repo/table-behavior.test.ts` covering the ordering contracts directly (e.g. version bump runs after `.set()` and overwrites a user-supplied version value).
- Updated `tests/unit/repo/table-runtime.test.ts` to focus on hook/virtual delegation and the new `behavior` property.
- All checks green: `just fix` + `bun test tests/unit`.

**What the behavior module hides:**
- Soft-delete pre-select filtering and `withTrashed()` interaction.
- Optimistic-lock `setRaw` version bump and the post-`.set()` ordering requirement.
- Soft-delete delete-to-update rewrite.
- Restore builder construction (`SET deletedAt = NULL WHERE ... IS NOT NULL`) plus post-set transforms.
- Soft-delete / optimistic-lock column guards.

**Public surface preserved:** `repo.read.*`, `repo.write.*`, and `repo.write.updateWithLock()` / `repo.write.restore()` still work exactly as before.

---

## Candidate 4: Migration Operation Lifecycle ✅ completed

**Status:** Implemented.

**Cluster (old):**
- `src/migration/diff.ts` ✅ rewritten as thin composer (returns pure array, no mutable accumulator)
- `src/migration/diff/tables.ts` ✅ extracted into standalone differ
- `src/migration/diff/columns.ts` ✅ extracted into standalone differ
- `src/migration/diff/enums.ts` ✅ extracted into standalone differ
- `src/migration/diff/indexes.ts` ✅ extracted into standalone differ
- `src/migration/diff/foreign-keys.ts` ✅ extracted into standalone differ
- `src/migration/ddl.ts` ✅ kept (pure SQL builders; now sole owner of DDL strings)
- `src/migration/sync.ts` ✅ updated to use unified `generateDownSql` from `reverse.ts`
- `src/migration/index.ts` ✅ updated to use unified `generateDownSql` from `reverse.ts`
- `tests/unit/migration/sync-down-sql.test.ts` ❌ deleted (duplicate coverage; unified reverse tests replace it)

**New deep module:**
- `src/migration/reverse.ts` — sole owner of reverse/down SQL generation.

**Why they were coupled:**  
`diffSchema` passed a shared mutable `MigrationOp[]` to every sub-differ, and DDL generation was split between `ddl.ts` and the differs. Reverse/down SQL was implemented twice (`generateReverseOp` vs `buildSyncDownSql`) with divergent behavior — `sync.ts` used a different format than migration file generation.

**Dependency category:**  
**In-process / local-substitutable.** Needs the desired table registry and an introspected schema; both can be supplied in-memory in tests.

**Outcome:**
- Each sub-differ (`tables`, `columns`, `enums`, `indexes`, `foreign-keys`) now returns `MigrationOp[]` directly; `diffSchema` is a pure composer.
- `reverse.ts` is the single source of truth for down SQL — both `sync.ts` and `index.ts` call `generateDownSql` from there.
- Unified the "cannot reverse" message format: all irreversible ops fall to the `default` case (`-- Cannot reverse: ${op.description}`); removed redundant explicit cases for `drop_table`, `drop_column`, `drop_fk`, `drop_index`.
- Added unit tests directly targeting each differ boundary: `diff-tables.test.ts`, `diff-columns.test.ts`, `diff-enums.test.ts`, `down-sql.test.ts`.
- Deleted `tests/unit/migration/sync-down-sql.test.ts` (now redundant with unified `down-sql.test.ts`).
- All checks green: `just fix` (circular, typecheck, lint, build) + `bun test tests/unit` (953 tests).

**What the refactoring hides:**
- The mutable accumulator pattern is gone; each differ owns its own slice of ops.
- DDL string ownership is fully in `ddl.ts`; differs never build SQL strings directly.
- Reverse SQL format divergence eliminated — one path for migration files and sync history alike.

---

## Candidate 5: Transaction / Sync Executor Abstraction

**Cluster:**
- `src/sql/database.ts`
- `src/sql/connection-lifecycle.ts`
- `src/sql/transaction-runner.ts`
- `src/sql/adapter.ts`
- `src/migration/sync.ts`
- `src/migration/rollback.ts`

**Why they're coupled:**  
`syncSchema` and `rollback.ts` construct transaction executors inline and call `asDriver(...).begin` directly. `Database` is the single wiring point for four runners, with no injection seam. `TransactionRunner.run` bundles overload parsing, ALS context, driver begin, isolation/timeouts, callback dispatch, and savepoints.

**Dependency category:**  
**Ports & adapters.** The real dependency is the `bun:sql` driver; tests already mock it. A defined `Driver`/`Executor` port would let the logic be tested against an in-memory/test adapter.

**Test impact:**
- No unit tests for `Database` wiring or `syncSchema` full flow.
- Executor/adapter changes break many tests at once.

---

## How this document is used

1. Pick the next candidate to deepen.
2. Frame the problem space: constraints, dependencies, and an illustrative (not final) interface sketch.
3. Design 2–4 radically different interfaces in parallel via sub-agents.
4. Compare designs, recommend one, and (optionally) create a GitHub issue RFC.
5. Implement the chosen design directly in the codebase, updating this document with the outcome.
