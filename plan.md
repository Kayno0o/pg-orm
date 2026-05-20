P3 — Testing & ops:
- Integration tests for the gaps (JSONB mutations, batch boundaries at 5000, optimistic-lock concurrency races, transaction rollback chaining, bigint round-trip).
- Database.getPoolStats() and Database.explain(builder). 
- .husky/pre-push running bun test.
- Compile examples/*.ts in CI.
