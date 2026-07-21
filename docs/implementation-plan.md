# Implementation plan - consumer-driven improvements

Execution plan for the remaining items of [`consumer-driven-improvements.md`](./consumer-driven-improvements.md).
Batch A (items 1, 2, 9, 3) is shipped; each item there carries a **Shipped** note in the source doc.

| batch | items | status |
| --- | --- | --- |
| A - contained wins | 1 memoize `repo()`, 2 debug logging, 9 `upsertOne`, 3 optional `where` | done |
| B - typing | 6 column validation metadata, 7 introspection helpers, 4 table-def relations | next |
| C - features | 8 bare-expression reads, 5 `includeCount`, 10 `tx.repo()` | after B |
| D - behaviour + docs | 11 `groupBy` projection, 12 trait naming presets, 13 README accuracy | last |

Ordering rationale: B unblocks `@kaynooo/elysia` deriving real validators and is pure type surface;
item 4 must land before item 5, because `include()` on an `<any>`-typed relation is the reason
`include()` is unused. D is last because 11 is the only behaviour change in the whole list.

---

## Batch B - typing gaps

### 6. Expose column validation metadata

**Goal.** `.min/.max/.minLength/.maxLength/.pattern/.oneOf` and enum values become readable from a
`ColumnDef` so framework bindings can derive request validators from the schema.

The plumbing already exists: `src/schema/column-meta.ts` has `ColumnDefMeta` + `getColumnMeta(def)`,
built for the migration differ. The gap is that it is not exported from `src/index.ts` and the
underscore fields are not on the public `ColumnDef`.

**Steps.**

1. Export `getColumnMeta` and `type ColumnDefMeta` from `src/index.ts` (via `src/schema/index.ts`).
2. Add `readonly validation?: ColumnValidation` to `interface ColumnDef` (`src/types/index.ts`),
   populated in `ColumnBuilder._build()` from the same `_`-prefixed fields. `ColumnValidation` =
   `{ min?, max?, minLength?, maxLength?, pattern?, oneOf?, enumName?, enumValues? }`, all readonly.
   Populate it only when at least one field is set, so the common column keeps its current shape.
3. Keep `getColumnMeta` as the migration-layer accessor - it also carries `index`/`renamedFrom`,
   which are not validation and should stay off the public type.

**Decision.** Two surfaces (`col.validation` for consumers, `getColumnMeta(col)` for internals)
rather than one. The alternative - promoting every `_` field onto `ColumnDef` - widens the public
type with migration-only concerns (`renamedFrom`, `index`) that no consumer should read.

**Tests.** `tests/unit/schema/column-validation.test.ts`: each builder method lands on
`col.validation`; a plain column has `validation === undefined`; `getColumnMeta` still returns the
migration fields.

**Risk.** None - additive, no runtime path touched.

### 7. Schema introspection helpers for framework bindings

**Goal.** Delete the duck-typing in `@kaynooo/elysia/src/crud.ts` and `dashboard-v2/orm/index.ts`.

**Steps.**

1. `src/types/index.ts`: add a typed `TableMeta` interface matching what the traits write today
   (`src/traits/index.ts`): `{ softDelete?: { column: string }, timestamps?: { createdAt: string, updatedAt: string }, optimisticLock?: { column: string }, _appliedTraits?: string[] }`.
   Retype `TableDef.meta` as `TableMeta & Record<string, unknown>` - keeps arbitrary keys writable
   while typing the three the ORM owns.
2. New `src/schema/introspect.ts` (name it `table-info.ts` to avoid confusion with
   `src/migration/introspect.ts`, which introspects the live DB):
   - `traitManagedColumns(table): Set<string>` - soft-delete, timestamps, and lock columns, read
     from `TableMeta`, not from column-name guesses.
   - `writableColumns(table, opts?: { managed?: boolean }): string[]` - all columns minus primary
     key, minus generated, minus trait-managed unless `managed: true`.
   - `isTableDef(value): value is AnyTableDef` - structural check on `name`/`columns`/`primaryKey`
     plus `typeof withTrait === 'function'`, i.e. the same predicate dashboard-v2 hand-rolls to
     glob-discover tables.
3. Export all three plus `TableMeta` from `src/index.ts`.

**Decision.** `traitManagedColumns` reads `meta`, never column names. The soft-delete column is
configurable (`softDelete('deleted_at')`), so any name-based heuristic is wrong the moment someone
renames it.

**Tests.** `tests/unit/schema/table-info.test.ts`: a bare table, a table with all three traits, a
table with custom trait column names, generated columns, composite PK. `isTableDef` rejects plain
objects, `null`, and a `ColumnDef`.

**Risk.** Low. `meta` retyping is source-compatible for readers; anything writing arbitrary keys is
still allowed by the `& Record<string, unknown>` half.

### 4. Relations accept a table-def thunk

**Goal.** `r.hasMany(() => TierListTier, 'tier_list_id')` with both the target table name and the row
type inferred, instead of `r.hasMany<any>('tier_list_tier', 'tier_list_id')`.

`.references(() => User, 'id')` (`src/schema/columns.ts`) already proves the lazy thunk survives the
circular imports that two-phase `withRelations` exists to dodge.

**Steps.**

1. `src/types/index.ts` - overload each factory on `RelationTypes`:

   ```ts
   belongsTo: {
     <TResult = Record<string, any>, TNullable extends boolean = false>(
       targetTable: string, foreignKey: string, opts?: { nullable: TNullable },
     ): RelationDef<'belongsTo', TResult, TNullable>
     <TTarget extends AnyTableDef, TNullable extends boolean = false>(
       target: () => TTarget, foreignKey: keyof TTarget['columns'] & string, opts?: { nullable: TNullable },
     ): RelationDef<'belongsTo', InferSelect<TTarget['columns']>, TNullable>
   }
   ```

   `hasMany`/`hasOne` follow the same shape; `hasManyThrough` takes two thunks
   (`(target, pivot, { from, to })`).
2. `src/schema/relations.ts` - `simpleRelation` resolves the argument: `typeof target === 'function' ? target().name : target`, then `validateIdentifier` as today. The thunk **must** be called
   eagerly here (relations are declared inside `withRelations`, after every table exists) so that
   `RelationDef.targetTable` stays a plain string and nothing downstream - resolver, assembler,
   migration differ - has to learn about thunks.
3. FK constraint: `foreignKey` names a column on the *child* table for `hasMany`/`hasOne` and on the
   *owning* table for `belongsTo`. Only constrain the generic where it is actually the target's
   column (`hasMany`/`hasOne`); leaving `belongsTo`'s FK as `string` avoids threading the owning
   table's columns into `RelationTypes`, which `withRelations` does not have at that point.

**Decision.** Eager resolution inside the factory, not a lazy `targetTable` getter. Lazy would touch
every consumer of `RelationDef.targetTable` (relation-resolver, include assembly, docs generation)
for no benefit - `withRelations` is already the "everything exists now" phase.

**Tests.** `tests/unit/schema/relations.test.ts`: thunk and string forms produce identical
`RelationDef`s; a type-level test (`expectTypeOf`-style assertion or a `tsc`-checked fixture) that
`include('posts')` on a thunk relation yields the target row type, not `any`; existing string-form
tests stay green.

**Risk.** Medium - overload resolution can degrade inference for existing explicit-generic call
sites (`r.belongsTo<SteamCategoryInterface>('steam_category', 'category_id')`). Mitigation: keep the
string overload **first** in declaration order and add a fixture covering the explicit-generic form.

---

## Batch C - features

### 8. Bare-expression read API

**Goal.** Serve the 43% of read sites that are `q => q.where(e => ...)` and nothing else.

**Steps.** In `src/repo/read-suite.ts` (delegating to the existing pipeline, no new SQL path):

```ts
findOneBy(where: WhereFn<TColumns>): Promise<WithVirtuals<...> | null>
findManyBy(where: WhereFn<TColumns>, opts?: { orderBy?: [col, dir?][] | col, limit?: number, offset?: number }): Promise<WithVirtuals<...>[]>
findOneByOrThrow(where: WhereFn<TColumns>): Promise<WithVirtuals<...>>
```

Each builds the `SelectCb` internally: `q => { q.where(where); … }`.

**Decision.** New names, not overloads of `findMany` - restating the source doc's reasoning because
it is the crux: the callback argument type (`SelectBuilder` vs `ExprBuilder`) must be chosen *before*
the callback runs, so the two shapes are not runtime-distinguishable. `count`/`exists`/`deleteMany`
already take the bare expression, so `*By` reads as the same convention rather than a new one.

`opts` covers `orderBy`/`limit`/`offset` only. Anything richer (pick, include, joins) goes through
the builder - `findManyBy` is deliberately the shallow path, not a second query API.

**Tests.** `tests/unit/repo/ops/find-by.test.ts` against the mock executor: emitted SQL matches the
builder equivalent for where-only, where+orderBy, where+limit; soft-delete filter still applied;
virtuals still applied.

### 5. `includeCount` - aggregate relation loading

**Goal.** Kill the `db.raw` + `Map` join pattern (`api/routes/feed.ts:139` and the four Steam
library sites).

**Sequencing.** Land item 4 first, then **re-measure `include()` adoption in both consumers** before
building this. If the typing fix alone moves the four hand-rolled joins onto `include()`, the
remaining gap is genuinely just the aggregate case and this stays small.

**Steps.**

1. `SelectBuilder.includeCount(relation, opts?: { as?: string, where?: WhereFn<TargetColumns> })` -
   records an entry in a new `state.includeCounts`, typed into `TResult` as
   `Record<As, number>` (default alias `${relation}Count`).
2. `src/repo/relation-resolver.ts` - one extra batched query per counted relation:
   `SELECT fk, COUNT(*)::int FROM child WHERE fk IN (...) [AND where] GROUP BY fk`, reusing the
   existing `#runChunked` chunking so the IN list can't overflow the bind limit. Missing keys map to
   `0`, not `undefined`.
3. `hasManyThrough` counts through the pivot; `belongsTo`/`hasOne` reject at build time with
   `ValidationError` (counting a single parent is meaningless).

**Tests.** Unit: SQL shape + zero-fill for absent parents. Integration
(`tests/integration/relations.test.ts`): counts against real rows, with and without the `where`,
including a soft-deleted child to prove the child's own trait filter applies.

### 10. `tx.repo(Table)`

**Goal.** A transaction body reads like normal code instead of `repo(X).using(tx)` per table.

**Steps.**

1. Add `repo(table)` to `TransactionClient` and `SavepointClient` (`src/sql/transaction.ts`),
   memoized per client with the same `WeakMap<AnyTableDef, { version, repo }>` shape used by
   `Database.repo` - a transaction client is short-lived, so the cache dies with it.
2. The clients need the registry/limits `Repository` wants (`tableRegistry`, `maxIncludeDepth`,
   `defaultLimit`, `batchChunkSize`). `TransactionRunner` currently gets only hooks and timeouts;
   thread a single `RepoDefaults` object from `Database` through `TransactionRunner` into each
   client rather than five loose params.
3. Extract the memoization into one helper (`src/repo/repo-cache.ts`) used by both `Database` and
   the transaction clients, instead of a second copy of the version-check.

**Tests.** Integration: `tx.repo(users)` writes roll back with the transaction; two calls return the
same instance; `tx.repo(t)` and `db.repo(t)` are *different* instances (different executor).

---

## Batch D - behaviour change and docs

### 11. `groupBy` projects its grouping columns

**Only behaviour change in the list.** Today `groupBy('category')` emits `GROUP BY "category"` but
leaves `category` out of the SELECT list, so `examples/showcase.ts:152` needs
`.computedRaw<string>('"category"', 'category')` to get the group key back.

**Steps.**

1. `src/builder/assembler.ts` - when `state.groupBy.length` and no explicit projection is set
   (`columns === null` and no `pick`), emit the grouping columns alongside the aggregates instead of
   `*`. When a projection *is* set, leave it alone - the caller has said what they want.
2. Type it: `groupBy(...cols)` returns `SelectBuilder<…, TResult & Pick<InferSelect<TColumns>, cols[number]>>`.
3. Changelog entry under a **Breaking changes** heading, with the one-line migration (drop the
   `computedRaw` shim) and the opt-out (set an explicit projection).

**Risk.** Anyone relying on grouped columns being absent from the result gets extra keys. That is
the announced break; keep it isolated in its own commit so it can be reverted alone.

### 12. Naming-convention defaults for traits

`timestamps({ createdAt, updatedAt })` and `softDelete(column)` already accept custom names, so this
is smaller than the source doc implies. What's missing is a default, since both consumers repeat the
same override on every table.

**Steps.** Export snake presets from `src/traits/index.ts`:
`timestampsSnake()` = `timestamps({ createdAt: 'created_at', updatedAt: 'updated_at' })`,
`softDeleteSnake()` = `softDelete('deleted_at')`, `optimisticLockSnake()` = `optimisticLock('version')`
(unchanged name, exported for symmetry).

**Decision.** Presets, not a `Database`-level `traitDefaults`. Traits are applied at `defineTable()`
time, long before a `Database` exists; a database-level default would either have to mutate table
defs after the fact or silently disagree with what the schema declares. **No automatic case
conversion, ever** - "identifiers are verbatim" is the security boundary that makes the JIT mapper
and identifier interpolation safe.

### 13. README accuracy

Fix alongside whichever items land, since the README is the canonical API reference:

- the quickstart shows `UserRepo.findMany()` / `UserRepo.insertOne()`; the suites (`repo.read.*`,
  `repo.write.*`) are the only API. This is the most-copied snippet in the file.
- "Column Types" lists `textArray`, `intArray`, and `char`, none of which exist in
  `src/schema/column-types.ts`; it omits `array(inner)`, `citext`, `int2`/`float4`/`float8`. The
  schema example on line 97 uses `t.textArray()` and would not compile. (`bit`/`varbit` do exist.)
- `findOrCreate`/`restore`/`forceDelete` appear only in prose - `findOrCreate` and `upsertOne` now
  have examples in the Mutations section; `restore`/`forceDelete` still need them.

Add a docs check to the release routine so the drift doesn't come back: the quickstart snippet
should be a compiled file under `examples/`, not prose.

---

## Conventions for every batch

- One commit per item, conventional-commit title, breaking changes marked `!` with the full
  description in the body.
- `just fix` then `just test` before each commit; unit tests use the mock executor, integration tests
  only where real PG behaviour is the thing under test.
- Each landed item gets a **Shipped** note appended to its section in
  `consumer-driven-improvements.md`, so that file stays the audit trail and this one stays the plan.
- Changelog entry per item under `## Unreleased`. Never touch `package.json`'s `version`.
