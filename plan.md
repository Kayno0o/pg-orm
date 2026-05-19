P1 — Architecture splits. Four files >900 LOC, each a separate, low-risk refactor that unlocks testing:

1. Split src/builder/query.ts (1,284 LOC) into state.ts / assemble.ts / base.ts / one file per builder. Side-wins: dedupe the 6 clone() copies and the 5 returning() overload chains via the base class. ~½ day, mechanical.
2. Extract RelationLoader from repo/index.ts (1,053 LOC) — _loadIncludes, _batchQuery, _loadBelongsTo, _batchThroughQuery move into src/repo/relations.ts. Repository becomes a thin orchestrator. Unlocks unit testing relation loading without a live DB.
3. Extract MigrationDiffer / Introspector / Applier from migration/index.ts (1,073 LOC) — each diff strategy becomes independently unit-testable with fixtures.
4. Tighten the getBuilderState leak — replace the @internal free function with a public getState() returning a BuilderState interface (do this during split #1, not as a separate pass).

After P1 lands

P2 — Code quality cleanup. Mostly mechanical and very visible in IDE hovers:
- Replace 15 as never casts in schema/columns.ts with proper narrowing types.
- Centralize magic constants (MAX_INCLUDE_DEPTH, BATCH_CHUNK_SIZE, 'id' PK default) into src/constants.ts + expose via DbConfig.
- buildPlaceholders(), _requireSoftDelete(), _getPrimaryKey() helpers.
- Rename public clone() → branch(); keep clone() protected.

P3 — Testing & ops:
- Integration tests for the gaps (JSONB mutations, batch boundaries at 5000, optimistic-lock concurrency races, transaction rollback chaining, bigint round-trip).
- Database.getPoolStats() and Database.explain(builder). 
- .husky/pre-push running bun test.
- Compile examples/*.ts in CI.
