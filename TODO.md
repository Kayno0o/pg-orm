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

- [ ] Lifecycle hooks system (@BeforeInsert, @AfterUpdate, etc.)
- [ ] Schema migrations support
- [ ] Database seeding utilities (via fixtures)
- [ ] Performance monitoring/profiling tools
