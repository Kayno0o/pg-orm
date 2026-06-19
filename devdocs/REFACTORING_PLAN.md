# pg-orm Refactoring Plan

This document tracks architectural-deepening opportunities identified in the codebase. The goal is to replace shallow, tightly-coupled module clusters with **deep modules**: small interfaces that hide large, cohesive implementations.

> Deepening follows the philosophy from John Ousterhout's *A Philosophy of Software Design*: the best modules have a simple interface hiding a complex implementation.

---

## Candidate 1: Repository Write-Operation Pipeline (active)

**Status:** In design — see framing below.

**Cluster:**
- `src/repo/ops/insert-one.ts`
- `src/repo/ops/insert-many.ts`
- `src/repo/ops/update-many.ts`
- `src/repo/ops/delete-many.ts`
- `src/repo/ops/force-delete.ts`
- `src/repo/ops/restore.ts`
- `src/repo/ops/upsert.ts`
- `src/repo/ops/find-or-create.ts`
- `src/repo/table-runtime.ts`
- `src/repo/write-suite.ts`

**Why they're coupled:**  
Every write-style operation repeats the same ~20-line orchestration:

1. Decide `RETURNING` columns based on `{ full: true }`.
2. Build the appropriate statement builder.
3. Apply pre-execution trait transforms (`applyPreSelect`, `applyPreUpdate`, `rewriteDelete`).
4. Run `before*` hooks.
5. Execute the query.
6. Run `after*` hooks.
7. Apply virtual fields when returning full rows.
8. Extract primary key(s) when returning keys.

The only real variation between ops is the builder type and the hook event names. Hooks, virtual installation, PK extraction, and the `{ full: true }` path are not hidden behind a common abstraction; they are re-declared in each file.

**Dependency category:**  
**In-process / local-substitutable.** The pipeline depends on the query builder, `TableRuntime`, and an executor. `tests/helpers/mock-executor.ts` already provides a test stand-in for the executor.

**Test impact:**
- Unit tests for ops all reuse `tests/unit/repo/ops/_helpers.ts` to wire the same dependencies, then retest the same orchestration.
- Divergences are easy to miss: `upsert.ts` fires `afterInsert` instead of `afterUpsert`, `find-or-create.ts` fires `beforeUpsert` + `afterInsert`, `restore.ts` fires `beforeUpdate`/`afterUpdate`, and `delete-many.ts` vs `force-delete.ts` differ only in whether `rewriteDelete` is consulted.
- A new op can forget `runtime.applyVirtuals(rows)` in the `{ full: true }` branch and existing unit tests for other ops will not catch it.

**Target outcome:**  
A single deep module that owns the entire write-operation lifecycle. Callers declare *what* operation they want and the pipeline handles *how* it is built, executed, hooked, and returned.

---

## Candidate 2: Hook, Virtual, and Mapper Post-Processing Pipeline

**Cluster:**
- `src/repo/table-runtime.ts`
- `src/repo/ops/find-many.ts`
- `src/repo/ops/stream.ts`
- `src/repo/relation-resolver.ts`
- `src/mapper/index.ts`

**Why they're coupled:**  
`afterSelect` hooks are open-coded in `findMany`/`stream` instead of going through `runtime.runAfter`. Eager-loaded child rows skip hooks, virtuals, and mapper coercion entirely. The decision of *when* to map rows, apply virtuals, and run hooks is spread across callers.

**Dependency category:**  
**In-process.** Pure row transformation and hook running (mapper uses `new Function`, but it is still internal computation).

**Test impact:**
- Boundary behavior is only covered by integration tests.
- Unit tests of helpers pass, giving a false sense of coverage, because the real failure modes live in how helpers are composed.

---

## Candidate 3: Trait Middleware / Table-Behavior Pipeline

**Cluster:**
- `src/repo/table-runtime.ts`
- `src/repo/ops/delete-many.ts`
- `src/repo/ops/update-many.ts`
- `src/repo/ops/restore.ts`
- `src/repo/ops/update-with-lock.ts`
- `src/traits/`

**Why they're coupled:**  
Callers must know the ordering contract for trait rules:

- `applyPreSelect` must run before `toSQL`.
- `applyPreUpdate` must run *after* `.set()` so it can inject `setRaw`.
- `restore` open-codes the soft-delete-column check instead of using a trait pipeline.
- `updateWithLock` relies on `updateMany` calling `applyPreUpdate` at the right moment.

The runtime knows *that* a trait exists, but every op knows *when* to apply it.

**Dependency category:**  
**In-process.** Trait rules are pure table-state transformations.

**Test impact:**
- `table-runtime.test.ts` tests each helper alone.
- The ordering is only verified by integration tests (`soft-delete.test.ts`, `optimistic-lock.test.ts`). A new op that calls `applyPreUpdate` before `.set()` would pass its own unit test and break optimistic locking in production.

---

## Candidate 4: Migration Operation Lifecycle

**Cluster:**
- `src/migration/diff.ts`
- `src/migration/diff/tables.ts`
- `src/migration/diff/columns.ts`
- `src/migration/diff/enums.ts`
- `src/migration/diff/indexes.ts`
- `src/migration/diff/foreign-keys.ts`
- `src/migration/ddl.ts`
- `src/migration/sync.ts`
- `src/migration/rollback.ts`
- `src/migration/types.ts`

**Why they're coupled:**  
`diffSchema` passes a shared mutable `MigrationOp[]` to every sub-differ, plus side-channel maps populated by implicit ordering. DDL generation is split between `ddl.ts` (create table/column) and the differs (index, enum, FK, alter type). Reverse/down SQL is implemented twice (`generateReverseOp` vs `buildSyncDownSql`) with divergent behavior.

**Dependency category:**  
**In-process / local-substitutable.** Needs the desired table registry and an introspected schema; both can be supplied in-memory in tests.

**Test impact:**
- Individual differs have no unit tests; coverage is only through `diffSchema`.
- Quoting/type-rendering inconsistencies and reverse-SQL divergence are easy to miss.

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
4. Compare designs, recommend one, and create a GitHub issue RFC.
5. Implement the chosen design, updating this document with the outcome.
