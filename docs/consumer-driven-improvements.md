# Consumer-driven improvements

Improvement plan derived from auditing every pg-orm call site in the two real consumers:

- `dashboard-v2` (`orm/` + `api/`, 50 tables, 216 `repo(X)` call sites)
- `kaynooo.fr` (`orm/` + `api/`, 12 tables)
- `@kaynooo/elysia` (`src/crud.ts`, `src/query.ts`, `src/findOneOr404.ts`) - a third-party-ish
  consumer that wraps pg-orm for HTTP CRUD, and therefore exposes what the lib fails to expose.

Everything below is a workaround that already exists in consumer code. Nothing here is speculative.

Measured usage (both apps, all read/write suite calls):

| op | sites |
| --- | --- |
| `read.findMany` | 87 |
| `write.updateOne` | 65 |
| `read.findOne` | 42 |
| `write.deleteMany` | 30 |
| `write.deleteOne` | 15 |
| `write.updateMany` | 3 |

`include` 4 sites, `paginate` 2, `db.raw` 9, `transaction` 0, `stream*` 0, `findById` 0, `count` 0.

---

## P1 - repeated verbatim in both consumers

### 1. Memoize `db.repo()` - DONE

**Evidence.** `dashboard-v2/orm/index.ts:42` and `kaynooo.fr/orm/index.ts:48` contain the *same*
helper, byte-identical apart from the doc-comment example:

```ts
const repoCache = new WeakMap<AnyTableDef, unknown>()

export function repo<TName extends string, TColumns extends AnyColumns, TRelations extends AnyRelations, TVirtuals extends AnyVirtuals>(
  table: TableDef<TName, TColumns, TRelations, TVirtuals>,
): Repository<TColumns, TRelations, TVirtuals> {
  const cached = repoCache.get(table)

  if (cached)
    return cached as Repository<TColumns, TRelations, TVirtuals>

  const created = db.repo(table)

  repoCache.set(table, created)

  return created
}
```

They wrote it because `Database.repo()` (`src/sql/database.ts:120`) news up a `Repository` on every
call, and dashboard-v2 calls `repo(Table)` inline 216 times, mostly per-request.

**Proposal.** Hold a `WeakMap<AnyTableDef, Repository>` in `Database` and return the cached instance.
`Repository` is already stateless w.r.t. queries (suites are lazy getters, `using(tx)` returns a new
instance), so caching is safe. Keep `using(tx)` uncached, or cache per-executor in a nested WeakMap.

**Impact.** Deletes ~15 lines + 4 type imports from every consumer; makes `db.repo(User)` the
idiomatic inline call. Non-breaking.

**Shipped.** `Database` holds a `WeakMap<AnyTableDef, { version, repo }>`. Table defs are mutable in
place (`withRelations`/`withVirtuals`/`withTrait`/`hook` all mutate and return the same object) while
`Repository` snapshots virtuals and trait behavior at construction, so each mutator bumps an internal
`table._version` and a stale entry is rebuilt. `using(tx)` stays uncached; `db.invalidateCache()`
drops the repo cache too.

### 2. Built-in query debug logging - DONE

**Evidence.** Both apps ship the same `onQuery` handler that inlines `$n` params back into the SQL,
gated on `DB_DEBUG=1`; kaynooo.fr keeps `SQL_PARAM_RE` in `common/regex.ts` solely for it.

```ts
onQuery: process.env.DB_DEBUG === '1'
  ? entry => log('info', `[${round(entry.durationMs, 3)}ms] ${entry.sql.replace(SQL_PARAM_RE, (b, g) => String(entry.params[Number(g) - 1] ?? b))}`)
  : undefined
```

**Proposal.** Export `formatQuery(event: QueryEvent, opts?: { colors?: boolean, maxParamLength?: number }): string`
and honour a `debug?: boolean | ((line: string) => void)` config flag that wires it to `onQuery`
(default off; respects the existing redaction rules so it can never be enabled in production by
accident). Non-breaking.

**Shipped.** `src/sql/format-query.ts` exports `formatQuery(event, { colors, duration, maxParamLength })`
and `composeQueryLogger`, which `Database` uses to layer `debug` on top of a user `onQuery` without
replacing it. Redaction is inherited from the error layer via two new helpers in `errors/index.ts`
(`queryLogsRedacted`, `getParamRedactor`): production / `REDACT_QUERY_LOGS=1` never wires the sink,
and a `redactParams` redactor is applied before values are inlined.

### 3. Conditional / optional `where` composition

**Evidence.** `@kaynooo/elysia/src/query.ts` exists purely to work around the `where` vs `andWhere`
split:

```ts
export function applyWhere<TQ extends WhereChainable>(builder: TQ, conditions: (WhereCb | null | undefined | false | '' | 0)[]): TQ {
  let b = builder
  let hasWhere = false

  for (const cond of conditions) {
    if (!cond) continue
    b = (hasWhere ? b.andWhere(cond) : b.where(cond)) as TQ
    hasWhere = true
  }

  return b
}
```

Used in `dashboard-v2/api/routes/{ports,nginx,feed}.ts` for optional query-string filters.

**Proposal.** Make `where()`/`andWhere()` accept `undefined | null | false` (no-op) and let
`andWhere()` work as the first clause. Optionally add `whereAll(conds: (WhereCb | falsy)[])`. Then
`applyWhere` can be deleted from `@kaynooo/elysia`. Non-breaking.

---

## P2 - typing gaps that push users off the typed path

### 4. Relations should take the table def, not a string + hand-written generic

**Evidence.**

```ts
// dashboard-v2/orm/steamGame.ts:106 - generic and string can drift apart silently
category: r.belongsTo<SteamCategoryInterface>('steam_category', 'category_id')

// kaynooo.fr/orm/tierlist.ts:13 - gave up on typing entirely
tiers: r.hasMany<any>('tier_list_tier', 'tier_list_id')
```

`.references(() => User, 'id')` already proves the lazy-thunk pattern survives circular imports
(`src/schema/columns.ts:165`), but relations only take a validated identifier string
(`src/schema/relations.ts:9`).

**Proposal.** Additive overloads:

```ts
r.belongsTo(() => SteamCategory, 'category_id')
r.hasMany(() => TierListTier, 'tier_list_id')
r.hasManyThrough(() => Tag, () => PostTag, { from: 'postId', to: 'tagId' })
```

Target name and row type both inferred; the FK column can be constrained to
`keyof TargetColumns & string`. Keep the string form for the deferred/dynamic case. Non-breaking.

**Note.** This is likely the root cause of item 5 below - a relation typed `<any>` makes `include()`
worthless.

### 5. `include()` is nearly unused; children get joined by hand

**Evidence.** 4 `include()` sites across both apps (`meal-plan.ts:124,139`, `chat-session.ts:17`,
`tierlistBoard.ts:9`). Everywhere else the same shape is hand-rolled: fetch children flat, build a
`Map`, join in JS. Steam library alone does it four times (`features`, `genres`, `companies`,
`community-tags` all `findMany(q => q.pick('id', 'game_id', ...))` then joined client-side), and
`api/routes/feed.ts:139` drops to raw SQL for unread counts per feed:

```ts
const counts = await db.raw<{ feed_id: number, c: number }>(
  'SELECT feed_id, COUNT(*)::int AS c FROM article WHERE is_read = false GROUP BY feed_id', [],
)
const countByFeed = new Map(counts.map(r => [r.feed_id, r.c]))
```

**Proposal.** Two parts.

1. Fix the typing (item 4) and re-measure; part of the avoidance is that `include('x')` on an
   `<any>` relation returns `any`.
2. Add aggregate-relation loading, which is the actually-missing feature:
   `q.includeCount('articles', { as: 'unread_count', where: e => e.eq('is_read', false) })`.
   One batched `GROUP BY` per relation, typed into the result.

Non-breaking (additive).

### 6. Column validation metadata is unreachable

**Evidence.** `ColumnBuilder` records `.min/.max/.minLength/.maxLength/.pattern/.oneOf` and
`_enumValues`/`_index`/`_renamedFrom` onto the built `ColumnDef` (`src/schema/columns.ts:212-236`),
but `interface ColumnDef` (`src/types/index.ts:30`) declares none of them. So
`@kaynooo/elysia/src/crud.ts:31 deriveCrudBody` derives request schemas from `pgType` +
`constraints` only, and silently loses every bound: an `f.varchar(8).oneOf(RATINGS)` column
validates as a bare string over HTTP.

**Proposal.** Add a public, typed `readonly validation?: { min?, max?, minLength?, maxLength?, pattern?, oneOf?, enumName?, enumValues? }`
on `ColumnDef` (populated from the same fields, `_`-prefixed ones kept as deprecated aliases for one
release). This turns "derive a validator from the schema" into a supported use case for any
framework binding. Non-breaking if additive.

### 7. Schema introspection helpers for framework bindings

**Evidence.** `@kaynooo/elysia/src/crud.ts:63` re-implements trait knowledge against an untyped bag:

```ts
const meta = table.meta as Record<string, any> | undefined
add(meta?.softDelete?.column)
add(meta?.optimisticLock?.column)
add(meta?.timestamps?.createdAt)
add(meta?.timestamps?.updatedAt)
```

plus `writableColumns(table, { managed })` filtering out PK/generated/trait columns.

**Proposal.** Export from pg-orm:

- a typed `TableMeta` interface (`softDelete`, `timestamps`, `optimisticLock` shapes) instead of
  `Record<string, unknown>`, with `meta` typed as `TableMeta & Record<string, unknown>`;
- `traitManagedColumns(table): Set<string>`;
- `writableColumns(table, opts?): string[]`;
- `isTableDef(value): value is AnyTableDef` - dashboard-v2 duck-types this
  (`orm/index.ts:9`: `'columns' in value && 'primaryKey' in value && typeof value.withTrait === 'function'`)
  to glob-discover tables.

Non-breaking.

---

## P3 - ergonomics with clear evidence

### 8. A bare-expression read API

**Evidence.** Argument shapes across all 129 `findMany`/`findOne`/`findOneOrThrow` sites:

| shape | sites |
| --- | --- |
| `where` only | 56 |
| `where` + `pick` | 25 |
| `where` + `orderBy` | 13 |
| `pick` only | 5 |
| `where` + `orderBy` + `limit` | 4 |
| `where` + `pick` + `limit` | 4 |
| `orderBy` only | 4 |
| no args | 4 |
| `pick` + `orderBy` | 3 |
| `orderBy` + `limit` | 2 |
| `where` + `include` | 2 |
| everything else (1 site each) | 7 |

So **43% of read sites are `q => q.where(e => ...)` and nothing else**, while `count(e => ...)`,
`exists(e => ...)`, `deleteMany(e => ...)` and `updateOne(set, e => ...)` already take the bare
expression. The asymmetry is the friction, not the builder itself.

**Proposal.** `findOneBy(e => ...)` / `findManyBy(e => ...)` / `findManyBy(e => ..., { orderBy, limit })`
as new methods, *not* an overload of `findMany`. An overload cannot work: the callback argument
(`SelectBuilder` vs `ExprBuilder`) has to be chosen before the callback runs, so the two shapes are
not runtime-distinguishable without making `SelectBuilder` also implement `ExprBuilder`. Distinct
names are unambiguous, match the existing `count`/`exists` convention, and leave the builder path
untouched for the other 57%.

Non-breaking.

### 9. `upsertOne` - DONE

**Evidence.** The only upsert in dashboard-v2 is a single-row call
(`api/utils/settings.ts:38`): `repo(Setting).write.upsertMany([{ key, value, updatedAt }], ['key'])`.

**Proposal.** `upsertOne(values, conflictTarget, updateColumns?, opts?)` returning
`InferPrimaryKey | row`, mirroring `insertOne`/`insertMany`. Trivial wrapper. Non-breaking.

**Shipped.** `WritePipeline.upsertOne` + `WriteSuite.upsertOne`; runs the `beforeUpsert` hook on the
single row and projects one result. Emits byte-identical SQL to a one-element `upsertMany` (asserted
in `tests/unit/repo/ops/upsert-foc.test.ts`).

### 10. Transaction ergonomics

**Evidence.** Zero `db.transaction` calls in either app, despite multi-step write flows that need
one - e.g. `kaynooo.fr/api/routes/tierlist.ts:160-180` does find-then-`updateOne`-or-`insertOne`
unguarded, hand-rolling the `findOrCreate` that already exists.

**Proposal.** `tx.repo(Table)` on `TransactionClient`/`SavepointClient` (same memoization as item 1)
so a transaction body reads like normal code instead of `repo(X).using(tx)` per table. Also document
`findOrCreate` in the README's mutation section - it is currently only mentioned in a bullet list.
Non-breaking.

### 11. `groupBy` should project its grouping columns

**Evidence.** `examples/showcase.ts:152` needs a raw string to get the group key into the result:

```ts
q.aggregate(e => ({ count: e.countCol(), avgPrice: e.avg('price') }))
  .computedRaw<string>('"category"', 'category')
  .groupBy('category')
```

Both apps skipped the builder for grouped aggregates entirely and used `db.raw` (9 sites: unread
counts, metric downsampling, `JOIN LATERAL` snapshots, timezone rollups).

**Proposal.** `groupBy(...cols)` adds those columns to the SELECT list and to `TResult` (typed from
`TColumns`), unless an explicit projection is already set. Behaviour change for anyone relying on
grouped columns being absent from the result - call it out in the changelog.

### 12. Naming-convention defaults for traits

**Evidence.** Both apps use snake_case tables/columns, but `timestamps()` contributes camelCase
`createdAt`/`updatedAt` (`src/traits/index.ts:118`), so every raw query mixes conventions:

```sql
SELECT name, date_trunc($1, "createdAt") AS bucket FROM metric WHERE "createdAt" >= now() - $2::interval
```

(`dashboard-v2/api/cron.ts:47`, `api/utils/electricity.ts:36`, and the `pick('...', 'updatedAt', 'createdAt')`
lists in `api/routes/note-item.ts`).

**Proposal.** Either a `Database`-level `traitDefaults: { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }`,
or exported snake presets (`timestampsSnake()`, `softDeleteSnake()`). Do not add automatic case
conversion - the "identifiers are verbatim" rule is the security boundary and must stay.

### 13. README accuracy

`README.md` documents things that do not exist:

- a `UserRepo.findMany()` / `UserRepo.insertOne()` shorthand (quickstart, lines 73-85) - the suites
  are the only API;
- column types `textArray`, `intArray`, `char`, `bit`-family naming that does not match
  `src/schema/column-types.ts` (real API: `array(inner)`, `citext`, no `char`/`textArray`/`intArray`);
- `paginateCursor` is shown but `findOrCreate`/`restore`/`forceDelete` only appear in prose.

Fix alongside whichever items land, since the README is the canonical API reference.

---

## Suggested sequencing

1. **Batch A (contained, non-breaking, immediate consumer win):** 1, 2, 9, 3.
   Lets both apps delete their `repo()` helper, their debug logger, and `applyWhere`.
2. **Batch B (typing):** 6, 7, 4.
   6 and 7 unblock `@kaynooo/elysia` deriving real validators; 4 is the bigger type-level change and
   should land with tests for the string form staying valid.
3. **Batch C (features):** 8, 5, 10.
   Re-measure `include()` adoption after 4 before building `includeCount`.
4. **Batch D (behaviour change + docs):** 11, 12, 13.

Each batch is independently shippable. Only 11 changes existing behaviour; everything else is
additive.
