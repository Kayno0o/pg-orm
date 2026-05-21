Phase 4 — Test coverage gaps (additive)
- Dedicated unit tests for sql/adapter, migration/rollback, migration/interactive, plus extensions to mapper and isolated tests for repo/{hooks,traits,virtuals}

Phase 5 — Repository operation suites (feat!:, BREAKING)
- Split Repository into repo.read / repo.write / repo.stream lazy suites
- Migrate all ~168 integration tests + write MIGRATION.md