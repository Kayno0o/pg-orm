# TODO

*allow breaking changes, the current project is an alpha*

## Completed ✅

- [x] add soft deletable decorator
- [x] improve code structure
  - [x] strongly refactor to make the structure smart, easy to read and maintain
  - [x] rework repository structure. current structure has a chain of extends which I don't like
- [x] create mixins for soft deletable, timestampable (like symfony traits)
- [x] modernize SQL generation with Bun's latest helpers (sql(object), sql.array())
- [x] optimize array handling for PostgreSQL
- [x] comprehensive test coverage for mixins

## Next Steps (Future)

- 1. [ ] Entity builder with mixins (DefaultEntity - contains base methods and id, Deletable - contains deleted_at, Timestampable - contains created_at and updated_at, ...)
- 2. [ ] Add query builder integration with mixins
- 3. [ ] Lifecycle hooks system (@BeforeInsert, @AfterUpdate, etc.)
- 4. [ ] Validation decorators (@Min, @Max, @Email, etc.)
- 5. [ ] Enhanced relation management (eager loading, lazy loading)
- 6. [ ] Schema migrations support
- 7. [ ] Query result caching
- 8. [ ] Database seeding utilities
- 9. [ ] Performance monitoring/profiling tools
