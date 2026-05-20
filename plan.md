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
