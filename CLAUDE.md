# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`@kaynooo/pg-orm` is a lightweight, type-safe PostgreSQL ORM built on Bun's native `bun:sql`. The README is the canonical reference for the public API surface (schema, query builder, relations, traits, migrations, transactions); this file covers internal architecture and workflows not obvious from reading individual files.

## Commands

Runtime is **Bun only** — never `node`/`npm`/`npx`. Use `bun`/`bunx`.

- **Verify before commit**: `just fix` — runs circular-dep check, typecheck (`tsc --noEmit --strict`), `eslint --fix`, and build, in that order. This is the standard "is it green" gate.
- **Tests**: `just test` — starts PG, runs the suite, stops PG (`bun run db:up && bun test && bun run db:down`). Extra args are forwarded to `bun test`: `just test tests/unit/builder`, `just test tests/unit/security.test.ts -t "rejects"`. PG is torn down even when tests fail.
  - Use bare `bun test` only when a PG is already up and you want to keep it running.
  - **Integration tests require a live PG** at `127.0.0.1:8532` (docker-compose, postgres:18-alpine). `bun run db:up` waits for the healthcheck; reset with `bun run db:reset`. Connection string in `.env` / `.env.example`.
  - Unit tests use `tests/helpers/mock-executor.ts` and never touch a real DB.
- **Coverage**: `bun run test:coverage` (lcov + genhtml).
- **Other checks**: `bun run circular` (madge), `bun run duplicates` (jscpd, 2% threshold), `bun run unused` (knip), `bun run bench` (CPU-pinned benchmarks).

The Husky pre-commit hook runs eslint + duplicates + build + typecheck on staged `.ts` files (tests are skipped there). CI (`.gitea/workflows/test.yml`) runs the same checks plus integration tests against a real PG.

## Architecture

Data flows: **schema definition → repository → query/expression builder → tape IR → SQL string → executor → JIT mapper → typed objects.** Each stage is a separate module under `src/`.

### Schema (`src/schema/`)
`defineTable(name, t => ({...}))` builds a `TableDef` carrying columns, indexes, relations, virtuals, hooks, traits, and a **pre-compiled JIT mapper**. Column names are validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` at definition time — this is the security boundary that makes the JIT mapper and identifier interpolation safe. Relations are wired *after* all tables exist via `.withRelations()` (avoids circular references). Traits (`src/traits/`) are pure transforms applied at `defineTable` time: they add columns/virtuals/hooks (e.g. `softDelete` adds `deletedAt` + `isDeleted` virtual + rewrites delete behavior).

### JIT mapper (`src/mapper/`)
Row-to-object mappers are compiled once per column-shape via `new Function()` and cached by shape fingerprint. **Only schema-defined column names ever enter the Function source** (JSON.stringify-escaped); user values never do. The mapper also coerces `int8`/`bigserial` (returned as JS strings by `bun:sql`) to `BigInt`. Identity fast-path when no pick/omit/bigint coercion is needed.

### Query & expression builders (`src/builder/`)
- `expr.ts` is the public WHERE/expression DSL; `_tape.ts` is its internal **flat-array IR** ("tape" of opcodes — `OP_EQ`, `OP_AND`, etc.) with no heap-allocated tree. `assembler.ts`/`assembleExpr` prints the tape to parameterized SQL.
- `query.ts` re-exports the statement builders (`SelectBuilder`, `InsertBuilder`, `UpdateBuilder`, `DeleteBuilder`, `MergeBuilder`, `UpsertBuilder`, `SetOperationBuilder`). `state.ts` holds immutable builder state; `assembler.ts` assembles the final query.
- Everything is parameterized. Raw escape hatches (`e.raw`, `q.computedRaw`, `.check`, `.defaultRaw`, `db.raw`) are the *only* unparameterized paths and are marked `@trusted` — treat any change there as security-sensitive.

### Repository (`src/repo/`)
`db.repo(table)` → `Repository`, which exposes three **lazily-constructed operation suites** (each allocates only on first property access):
- `repo.read` (`read-suite.ts`) — finds, count, exists, paginate, paginateCursor, `select()`.
- `repo.write` (`write-suite.ts`) — inserts, updates, `updateWithLock`, deletes, upserts, `findOrCreate`, `restore`, `forceDelete`, plus statement builders.
- `repo.stream` (`stream-suite.ts`) — `stream` (LIMIT/OFFSET) and `streamCursor` (keyset).

Each individual operation lives in its own file under `src/repo/ops/` (e.g. `insert-many.ts`, `update-with-lock.ts`). Cross-cutting per-table logic (trait behavior, hook running, virtuals, primary-key resolution) is consolidated in `table-runtime.ts` (`buildTableRuntime`). Relation eager-loading (`include()`, batched to avoid N+1) lives in `relation-resolver.ts`. Repositories rebind to a transaction via `repo.using(tx)`.

> **Note:** `insertOne`/`insertMany` must explicitly call `_applyVirtuals()` on results (`findMany` does it automatically). Don't assume mutations apply virtuals for free.

### SQL execution (`src/sql/`)
`Database` is a thin **facade** over four collaborators — keep this split when editing:
- `connection-lifecycle.ts` — pool, drain, retry.
- `transaction-runner.ts` — transaction body, savepoints, post-settlement `onCommit`/`onRollback` callbacks.
- `raw-runner.ts` — `db.raw()`.
- `migration-runner.ts` — `sync()` / `rollback()`.

`base-executor.ts` provides the shared query path (logging hooks, slow-query detection, error wrapping) and `AsyncLocalStorage`-based request context (`db.withContext`). `transaction.ts`/`tx-sql.ts` implement `TransactionClient`/`SavepointClient`.

### Error mapping (`src/errors/`)
All errors extend `OrmError`. PG errors are mapped to typed errors (`UniqueError`=23505, etc.). **Critical `bun:sql` quirk:** the PG error code is on `err.errno` (e.g. `"23505"`), NOT `err.code` (which is the generic `"ERR_POSTGRES_SERVER_ERROR"`). Always detect via `errno`. In `NODE_ENV=production` messages are sanitized; `REDACT_QUERY_LOGS=1` fully redacts SQL/params.

### Migration (`src/migration/`)
`db.sync()` introspects the live DB (`introspect.ts`), diffs against the table registry (`diff.ts` + `diff/` per-object-type differs: `tables`, `columns`, `enums`, `indexes`, `foreign-keys`), and applies DDL (`ddl.ts`). FK constraints are emitted as separate `add_fk` ops *after* all `create_table` ops so declaration order can't cause FK violations on an empty DB. `--allowDestructive` gates DROP operations; otherwise they throw `DestructiveOpError`. `history.ts`/`rollback.ts` handle migration-file generation and the migration table.

## Conventions

- **Strict TypeScript** with `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `verbatimModuleSyntax`. `_`-prefixed args/vars are allowed-unused.
- **No `as any`** — prefer generics, narrowing, or `as unknown as T`.
- **No `require()`/`import()` inside methods** — use top-level static imports (the linter auto-moves them anyway; it also sorts imports and reformats on `--fix`).
- **No circular dependencies** — `madge` enforces this in CI; the type-graph is layered (schema → builder → repo → sql).
- Breaking changes are acceptable — just call out what changed in the summary.
- Commit messages must **not** include a `Co-Authored-By` trailer.
- Version bumps: `just patch|minor|major` (npm version + tag push; tag push triggers the publish workflow).
