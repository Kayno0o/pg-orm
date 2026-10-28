# Migrating to @kaynooo/pg-orm 8.0.0

8.0.0 closes a set of correctness and security holes, and most of its breaking changes turn a call that silently did the wrong thing (matched every row, ignored a key, printed an unchecked keyword) into one that throws `ValidationError`. A codebase that typechecks on 7.x mostly keeps typechecking; what to look for is calls that start throwing at runtime. The renamed and removed APIs are listed last.

## Calls that now throw `ValidationError`

### Keys and WHERE clauses
- `findById`, `existsById`, `updateById`, `deleteById` and `findOrCreate` keys refuse an object, an array, `null` or `undefined`, which used to be read as an operator map or an IN list and could match every row. `attach`, `detach` and `sync` check the parent and target keys the same way.
- An `updateMany`, `updateOne`, `updateWithLock`, `deleteMany`, `deleteOne` or `forceDelete` whose WHERE is missing or holds for every row (an empty object, an `and()` of nothing) throws; `deleteAll()` is the one call that clears a table.
- A WHERE object whose value is an object naming no known operator (`{ id: { gtt: 1 } }`, `{ id: {} }`) throws on a non-JSON column, an `undefined` operand throws, and a LIKE pattern that is not a string throws.
- `insert`, `update` and `upsert` refuse a key that is not a column of the table, and every repository statement checks its bare column names (WHERE, pick, omit, ORDER BY, GROUP BY, RETURNING) against the table.
- An `alias.col` reference throws unless the statement, or one enclosing it, declares the alias and the aliased table has the column.

### Builders and options
- `orderBy` direction, `nulls` position, join type and lock mode accept only their fixed keywords.
- An insert with no values throws; values passed to a builder are copied, so mutating them later no longer changes the statement.
- `paginate`'s `perPage`, `paginateCursor`'s `take` and `nearest`'s `k` above `maxPageSize` (1000 by default, `DbConfig.maxPageSize`) throw.
- A `paginateCursor` cursor that is not one a page returned throws.
- `include`, `withCount` and the other relation aggregates, `whereHas` and `e.has` throw when the related table (or a `hasManyThrough` pivot) is missing from `config.tables`, as its scopes would be unknown.
- Retry options are validated when the `Database` is built.
- Two columns declaring the same enum name with different value lists make `sync` and `generate` throw.

### Migrations
- `apply` refuses a migration file edited after it was applied, and a file older than the last applied one. New history rows record a sha256 of the SQL; rows recorded by 7.x are compared by their SQL, so existing histories keep working.
- `status --check` exits non-zero on drift or pending files, for CI. A `sync` dry run lists destructive operations instead of throwing on them.
- The CLI redacts query parameters unless given `--raw`, and `sync`'s confirmation answers no on EOF and refuses when stdin is not a terminal.

## Behaviour changes

- **Scopes.** Traits and tables declare scopes, conditions every read, `include`, aggregate, count, update and delete carries unless lifted by name (`withoutScope('active')`, `{ withoutScopes: ['active'] }`). Soft delete is now the `softDelete` scope: `withTrashed` keeps working and means `withoutScope('softDelete')`. Upserts guard their update with the scopes, and `findOrCreate`'s lookup is scoped.
- **Soft-deleted pivots.** A soft-deleted pivot row links nothing in `include`, aggregates and relation filters, unless the scope is lifted.
- **Upsert hooks.** `upsertOne`, `upsertMany` and `findOrCreate` run `beforeInsert` and `beforeUpdate` on each incoming row, and `afterInsert` / `afterUpdate` for the rows inserted / updated. What `beforeUpdate` sets reaches the conflict update through `EXCLUDED`.
- **Hook context.** Every hook gets a second argument `ctx`; `ctx.repo(table)` is a repository on the write's executor (the `using(tx)` client, or a chunked write's own transaction). One-argument hooks keep working.
- **Chunked writes.** A write past the bind parameter limit runs its chunks in one transaction, and its after-write hooks run inside it after the last chunk: a hook that throws rolls the write back.
- **Paging order.** `paginate` without an `orderBy` orders by the primary key, so pages are disjoint; `repo.stream.offset` keeps a limit its callback sets; a `hasOne` include matching several rows takes the first in its callback's order, else the lowest primary key.
- **Redaction.** Query hooks get scrubbed parameters by default: raw ones only with `REDACT_QUERY_LOGS=0` or an identity `redactParams`. An error's `cause` is not enumerable, and time zone and syntax error messages no longer quote the offending value.
- **Packaging.** `@kaynooo/utils` is bundled (a devDependency), the `bun-types` peer dependency is gone, and the tarball ships `LICENSE`, `llms.txt` and `llms-full.txt` and no source maps.

## Renamed and removed

| 7.x | 8.0 |
| --- | --- |
| `TrashedOptions` | `ScopeOptions` (`withTrashed`, `withoutScopes`) |
| `repo.write.upsert()`, `UpsertBuilder` | `repo.write.insert().onConflict(...)`, or `upsertOne` / `upsertMany` |
| `setParamRedactor()` | `DbConfig.redactParams`, per `Database` |
| `Trait<TCols, TVirts>` | `Trait<TCols, TVirts, THost>`; the third parameter defaults, so a custom trait only spells it out to read the host table's row type |
| vector distance helpers returning `ExprTape` | `TypedExpr<number>`, still accepted wherever an `ExprTape` is, and typed as `number` in `computed()` |
