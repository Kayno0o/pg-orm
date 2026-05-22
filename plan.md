pg-orm Production-Readiness Improvement Roadmap

Context

@kaynooo/pg-orm (v4.0.4, ~8,000 LOC, Bun SQL + PostgreSQL ORM) is structurally sound: full parameterization, typed errors, traits/hooks, ~450 tests across unit and integration. The library is roughly 90% prod-ready. Three parallel audits (architecture,
security/correctness, DX/observability) surfaced ~30 candidate findings; this plan presents the high-leverage subset that moves the needle on prod-ready / maintainable / refactored / secure, ruthlessly prioritized.

Strengths to preserve (do not refactor away):
- Zero as any in src/ — user pref is honored
- Clean public API in src/index.ts — no internals leak (PLACEHOLDER_RE, OP_*, BuilderState, etc. all stay private)
- Strong error taxonomy (UniqueError, DeadlockError, SerializationError, isRetryable)
- Migration safety (DestructiveOpError, FK ordering fix)
- Dedicated security.test.ts, production-readiness.test.ts, optimistic-lock-races.test.ts

---
Findings — by impact

HIGH — security & correctness (defense-in-depth)

H1. Missing validateIdentifier() on JOIN / WINDOW / CTE names

- Where: src/builder/select.ts:108, 117, 125, 133, 209, 215, 221
- Problem: computed() validates aliases (select.ts:40, 61) but join(), leftJoin(), rightJoin(), fullJoin(), window(), with(), withRecursive() accept raw name/table/alias strings and pass them straight to assembler.ts for quote()-wrapping. No injection today
(assembler quotes), but identifier truncation at 63 bytes + asymmetric validation is a latent footgun.
- Direction: Call validateIdentifier(name, '<context>') at entry of each — matches the pattern already used in computed().

H2. with() / withRecursive() accept raw sql: string

- Where: src/builder/select.ts:215-225
- Problem: sql is trusted developer code, parameters are positional. If a caller does withRecursive('t', \... WHERE id = ${userInput}`, [])instead ofwithRecursive('t', '... WHERE id = $1', [userInput]), injection is possible. Also,
assembler.ts:116regex-renumbers$Nplaceholders, which silently corrupts CTEs that legitimately contain$N-looking string literals (e.g., WHERE body LIKE '%$1%'`).
- Direction: Document loudly in JSDoc that interpolation is forbidden. Add a runtime check that the count of $N placeholders matches params.length; mismatch → ValidationError.

H3. validateRawSqlFragment() doesn't handle PG-specific string literals

- Where: src/schema/validate.ts:85-175
- Problem: Validator scans for ;, --, /* outside '...' / "...", but doesn't recognize PG-specific forms: E'\\...' (escape strings), $tag$...$tag$ (dollar-quoting), U&'...' (Unicode strings). Used by partial-index WHERE predicates and any DDL fragment
validation.
- Direction: Extend the state machine to recognize the three PG forms, or explicitly reject them with a clear "use only standard string literals here" error.

---
HIGH — refactor / maintainability

H4. Database is a god object (487 lines)

- Where: src/sql/database.ts
- Problem: One class owns: pooling, table registry, migrations, transactions, repository factory, drain coordination, retry config, stream defaults, query event log. Hard to test slices in isolation; circular-dep risks latent.
- Direction: Pull out three collaborators behind narrow interfaces, keep Database as a thin facade:
  - RetryPolicy (composes with executor)
  - DrainCoordinator (already a file — make it the only owner of _inFlight)
  - MigrationRunner (move sync/rollback/status here)
  - Repository factory becomes a lazy getter on Database (no logic).
- Smart pattern: deep modules — Database should have a thin interface (5–6 public methods) hiding the orchestration.

H5. expr.ts and assembler.ts mix DSL with SQL printing

- Where: src/builder/expr.ts (495 lines), src/builder/assembler.ts (381 lines)
- Problem: expr.ts packs 25+ opcodes, tape format, and assembleExpr in one file; assembler.ts hand-crafts SQL for 8 query types with nested conditionals. Hard to audit each clause printer in isolation, easy to introduce identifier-quoting bugs when adding
features.
- Direction:
  - Move tape format and assembleExpr into src/builder/_tape.ts (internal); keep ExprBuilder public.
  - In assembler.ts, extract one printer-per-clause: printSelect, printWhere, printJoin, printCte, printGroupBy, printOrderBy, printLimit, printReturning, etc. Each takes a small SqlBuilder that owns placeholder counting and identifier quoting.
- Smart pattern: strategy + single-responsibility printers; identifier quoting goes through one bottleneck so it can be audited once.

H6. schema/columns.ts tangles column DSL, DDL emission, validation metadata (507 lines)

- Where: src/schema/columns.ts
- Problem: ColumnBuilder chains, type inference, DDL generators, enum handling, index options, validation metadata all live in one file. Adding a new column type (range, composite, vector) touches 50+ lines across builder methods.
- Direction: Split into a ColumnType registry (each entry: pgType, JSON shape, DDL formatter, default coercion, validation rules) and a thin ColumnBuilder DSL that consults the registry. New types become a single registration call.
- Smart pattern: registry over open-coded conditionals.

H7. Trait logic is sprayed across read/write/stream suites

- Where: src/repo/read-suite.ts, src/repo/write-suite.ts, src/repo/stream-suite.ts, src/repo/traits.ts
- Problem: applySoftDeleteFilter() called by hand in 5+ places; optimistic-lock version increments hidden in setRaw() inside write-suite.ts:70-76. No type-level guarantee a new read path remembers to filter; trait metadata read via unsafe casts.
- Direction: Define a small Trait middleware contract — applyPreQuery(builder) and applyPostResult(rows). Suites iterate registered traits once. Type-brand trait-aware builders so a missing filter is a compile error.
- Smart pattern: middleware/decorator over scattered conditionals.

---
MEDIUM — observability & DX

M1. No request-scoped query context

- Where: src/sql/base-executor.ts:42, src/sql/database.ts:~290
- Problem: QueryEvent.context exists but there's no public API to set it for a request scope. Production users can't correlate query logs to incoming HTTP requests.
- Direction: Add Database.withContext(ctx, fn) backed by AsyncLocalStorage (Bun supports it). Context flows to QueryEvent/SlowQueryEvent/QueryErrorEvent automatically.

M2. Hook & callback error handling is asymmetric

- Where: src/repo/hooks.ts, src/sql/transaction.ts:43-56
- Problem: runAfter() wraps in AfterHookError; runBefore() rethrows raw. onCommit/onRollback callbacks stop iterating on first throw — later callbacks silently dropped.
- Direction: Single HookErrorHandler contract used by all paths. Collect callback exceptions (AggregateError) and route them all to onCallbackError so none are dropped.

M3. DrainCoordinator.exit() can go negative

- Where: src/sql/drain.ts:17-30
- Problem: No invariant that exit() matches enter(). Silent imbalance corrupts drain behavior under shutdown.
- Direction: Guard with if (this._inFlight > 0) this._inFlight--, and emit an internal warning event on imbalance — fail fast in dev, log in prod.

M4. defaultLimit / safety-rails not in README

- Where: src/sql/database.ts:92-93 exposes defaultLimit; statementTimeout, idleInTransactionTimeout, application_name also exist but aren't documented as a unit.
- Direction: Add a "Production Checklist" section to README.md showing the recommended config (defaultLimit, statement/idle timeouts, application_name, retry, drain). One screen of copy-pasteable config beats prose.

M5. Integration test gaps on systemic failure modes

- Where: tests/integration/
- Problem: Already covers deadlocks, optimistic-lock races, tx rollback chains. Missing explicit coverage for: pool exhaustion (queue / time out / error path), streaming correctness under concurrent INSERT/DELETE, FK-add migration on populated tables.
- Direction: Add three integration tests in tests/integration/production-readiness.test.ts (or new files) for these three scenarios.

---
LOW — polish

L1. typescript is a runtime dependency

- Where: package.json:59
- Direction: Move to devDependencies. Verify dist/ ships only .js + .d.ts (bun run build and ls -lah dist). Likely a no-op for consumers but trims ~10 MB of installed weight.

L2. Missing "sideEffects": false

- Where: package.json
- Direction: Add "sideEffects": false so bundlers tree-shake — useful if consumers import only defineTable for schema-only tooling. Verify no module has top-level side effects first (grep -rn "^[a-zA-Z_].*=" src/*/index.ts or read all index.ts files).

L3. Public-method JSDoc is uneven

- Where: src/repo/read-suite.ts, src/repo/write-suite.ts, src/builder/select.ts
- Direction: One-liner /** ... */ for every public method and exported type. Highest ROI on SelectBuilder<TColumns, TRelations, TResult> — the three generics need an @template description so IDE hover is useful.

L4. Migration regex coverage

- Where: src/migration/regex.ts
- Direction: Add a snapshot-test matrix in tests/unit/migration/regex.test.ts (one fixture per PG catalog edge case) so regex changes can't silently break introspection.

---
Recommended next steps (suggested order)

If you want to ship one PR at a time, the highest ROI sequencing is:

1. H1 + H2 + H3 — security defense-in-depth (small, focused PR; 1–2 hours)
2. L1 — typescript → devDep (5 min, ship immediately)
3. H4 — split Database god object (medium PR; unlocks easier testing for the rest)
4. H7 — trait middleware (depends on H4 cleanup; biggest code-quality win)
5. H5 + H6 — assembler/expr/columns refactor (large; do last when test confidence is highest)
6. M1–M5 — observability, README, integration tests (parallel polish)
7. L2–L4 — final polish

---
Verification

Per-change verification (per memory): just fix runs circular-deps + tsc + lint:fix + build.

End-to-end:
- bun test tests/ — full 450-test suite, must stay green
- bun test tests/unit/security.test.ts — add cases for H1 (identifier validation) and H3 (PG string literals)
- bun test tests/unit/security.test.ts — add cases for H1 (identifier validation) and H3 (PG string literals)
- docker compose up -d + bun test tests/integration/ — DB-backed coverage
- bun run build && node -e "console.log(require('./dist').Database)" — smoke test the published bundle
- bunx knip — verify no unused exports after the refactors
- bunx madge --circular ./src/index.ts — confirm no new circular deps after splitting Database
- bunx jscpd ./src --threshold 2 --min-lines 10 — confirm the refactors actually reduce duplication

For the trait-middleware refactor (H7), specifically: re-run tests/integration/soft-delete.test.ts and tests/integration/optimistic-lock-races.test.ts — these are the canaries.

---
Out of scope (deliberately skipped)

- Public API surface — already minimal; the audit found nothing leaking.
- as any cleanup — grep -rn "as any" src/ returned nothing; user pref already enforced.
- Major API renames (findMany → findAll, etc.) — breaking, low ROI, churn for users.
- New ORM features (window functions, recursive views, geo) — not part of "prod-ready".
