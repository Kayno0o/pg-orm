Phase 2 — Architecture depth (refactor!:, ~2-3 sessions, mostly internal)
- Split sql/executor.ts (735 LOC) into database.ts, transaction.ts, retry.ts, drain.ts, tx-sql.ts, base-executor.ts — keep executor.ts as a barrel so imports don't change
- Encapsulate BuilderState mutations: add UpdateBuilder.setRaw, SelectBuilder.asExists, SelectBuilder.withStreamChunk so repo/index.ts stops reaching into .getState() directly
- Introduce TraitRegistry to centralize soft-delete / optimistic-lock / timestamps metadata
- Replace Repository's 6 positional params with a RepositoryConfig object

Phase 3 — Smart patterns (refactor:, ~1-2 sessions, internal)
- ChunkedQueryExecutor for relation-loader duplication
- ConstraintCollector for DDL single-pass scan
- Collapse identical where() overrides into WhereableMutationBuilder
- Real LRU cache for the mapper
- Centralize query error wrapping path

Phase 4 — Test coverage gaps (additive)
- Dedicated unit tests for sql/adapter, migration/rollback, migration/interactive, plus extensions to mapper and isolated tests for repo/{hooks,traits,virtuals}

Phase 5 — Repository operation suites (feat!:, BREAKING)
- Split Repository into repo.read / repo.write / repo.stream lazy suites
- Migrate all ~168 integration tests + write MIGRATION.md