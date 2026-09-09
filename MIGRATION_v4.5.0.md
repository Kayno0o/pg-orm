# Migrating to @kaynooo/pg-orm 4.5.0

**Nothing in 4.5.0 is breaking.** Every existing call site keeps compiling and keeps emitting the
same SQL. This release widens what the API accepts and fills in the operations that were missing;
migrating is entirely optional and can be done one file at a time.

Read the [Why](#why) section for the measurements this came from, then work through
[What to change](#what-to-change) for the mechanical rewrites.

---

## Why

The release is driven by an audit of every `@kaynooo/pg-orm` call site in `dashboard-v2`,
`kaynooo.fr`, `kloe-couture` and `@kaynooo/elysia` - 190 files, 789 scanned.

| signal | count |
| --- | --- |
| `e.eq(…)` calls | 402 of ~600 total expression calls |
| `.where(e => e.eq(x, y))` - a closure wrapping one equality | 131 |
| ...of which the whole argument was `q => q.where(e => e.eq(x, y))` | 102 |
| `e.and(…)` wrapping only `eq`s | 47 |
| find sites that were a WHERE and nothing else | 56 of 129 |

Three quarters of the expression DSL's use was single-column equality wearing a two-level closure.
Alongside that, three gaps forced consumers to hand-roll: `paginate` could not shape its page,
`count` could not see soft-deleted rows, and trait metadata was only reachable through
`table.meta as Record<string, any>`.

---

## What to change

### 1. A WHERE that is only equalities becomes an object

Every place that accepts a WHERE now also accepts `{ column: value }`. Entries are ANDed. Values
are parameterized exactly as before, and column names are still type-checked against the table -
a misspelling is a compile error, and a wrong value type is a compile error.

```diff
-q.where(e => e.eq('id', params.id))
+q.where({ id: params.id })

-q.where(e => e.and(
-  e.eq('user_id', user.id),
-  e.eq('resource_type', 'tierlist'),
-  e.eq('resource_id', params.id),
-))
+q.where({ user_id: user.id, resource_type: 'tierlist', resource_id: params.id })

-await repo(Article).write.deleteMany(e => e.eq('feed_id', feed.id))
+await repo(Article).write.deleteMany({ feed_id: feed.id })
```

`null` and arrays have shorthands too:

```diff
-q.where(e => e.isNull('parent_id'))
+q.where({ parent_id: null })

-q.where(e => e.in('id', grantedIds))
+q.where({ id: grantedIds })
```

An empty array still compiles to `FALSE`, so `{ id: [] }` matches nothing rather than raising a
syntax error.

For anything past equality, give the column an operator map. Several operators in one map are
ANDed together:

```diff
-q.where(e => e.gte('createdAt', from))
+q.where({ createdAt: { gte: from } })

-q.where(e => e.and(e.gte('age', 18), e.lt('age', 65)))
+q.where({ age: { gte: 18, lt: 65 } })

-q.where(e => e.contains('name', search))
+q.where({ name: { contains: search } })

-q.where(e => e.isNotNull('deletedAt'))
+q.where({ deletedAt: { isNull: false } })
```

Full operator list: `eq neq gt gte lt lte in notIn like ilike contains startsWith endsWith between
isNull`. `contains`/`startsWith`/`endsWith` escape LIKE metacharacters in the input, same as their
`ExprBuilder` counterparts.

**Keep the callback** for `OR`, `NOT`, subqueries (`exists`, `scalar`), JSONB paths, full-text
search, pgvector distances and `e.raw`. The object form covers conjunctions of column predicates
and deliberately stops there. The two mix freely:

```ts
q.where({ status: 'active' }).andWhere(e => e.or(e.gt('age', 18), e.eq('role', 'admin')))
```

#### Three rules worth knowing before you sweep

- **`undefined` throws.** `where({ id: undefined })` raises `ValidationError` instead of matching
  every row. This is deliberate: the same typo in a `deleteMany` would otherwise empty a table.
  If you want an optional filter, use the falsy no-op that already existed:
  `q.andWhere(status && { status })`.
- **`{}` throws** for the same reason - an empty clause would widen to every row.
- **An array-typed column takes no bare array.** `IN` on `text[]` would be indistinguishable from
  equality, so `{ tags: ['a', 'b'] }` is a compile error; write `{ tags: { eq: ['a', 'b'] } }`.
  A `json`/`jsonb` column accepts an object value directly (`{ prefs: { theme: 'dark' } }`); only
  an object whose keys are *all* operator names is read as an operator map.

#### Composing with a caller-supplied clause

If you were building predicates generically - a CRUD layer ANDing a route filter with a tenant
scope - `compileWhere` turns either form into a tape:

```diff
-function scopedWhere(base: WherePred, scope: ScopeFn | undefined, args: any): WherePred {
-  return scope ? (e: any) => e.and(base(e), scope(args)(e)) : base
-}
+import { compileWhere } from '@kaynooo/pg-orm'
+
+function scopedWhere(base: WhereInput<C>, scope: ScopeFn | undefined, args: any): WhereFn<C> {
+  return scope ? e => e.and(compileWhere(base), compileWhere(scope(args))) : () => compileWhere(base)
+}
```

### 2. `WHERE <pk> = <id>` becomes a by-id operation

```diff
-await repo(TierList).write.deleteOne(e => e.eq('id', params.id))
+await repo(TierList).write.deleteById(params.id)

-await repo(TierList).write.updateOne({ title }, e => e.eq('id', params.id), { full: true })
+await repo(TierList).write.updateById(params.id, { title }, { full: true })

-const row = await repo(User).read.findOne(q => q.pick('id').where(e => e.eq('id', userId)))
+const row = await repo(User).read.findById(userId, q => q.pick('id'))
```

New in the read suite: `findByIdOrThrow(id, cb?)` (throws `NotFoundError` rather than returning
`null`) and `existsById(id)`. `findById` now takes the same optional select callback as `findMany`,
so `pick`, `include` and `omit` work on a by-id load.

A composite primary key takes an object holding each part - `findById({ userId: 1, groupId: 2 })`.
A bare value, or an object missing a part, raises `ValidationError` instead of quietly matching on
whatever it could resolve.

### 3. A find that is only a WHERE loses its callback

`count`, `exists`, `updateMany` and `deleteMany` always took a bare predicate; the finds did not.
They do now:

```diff
-const one = await repo(Feed).read.findOne(q => q.where(e => e.eq('url', body.url)))
+const one = await repo(Feed).read.findOneBy({ url: body.url })

-const rows = await repo(AccessGrant).read.findMany(q => q.where(e => e.and(
-  e.eq('user_id', user.id),
-  e.eq('resource_type', 'tierlist'),
-)))
+const rows = await repo(AccessGrant).read.findManyBy({ user_id: user.id, resource_type: 'tierlist' })
```

`findManyBy`/`findOneBy` take a WHERE and nothing else. The moment you also need `pick`, `orderBy`
or `limit`, stay on `findMany(q => …)` - there is no options bag, on purpose.

### 4. `paginate` can shape its page, and its total finally agrees with it

```diff
-const [rows, total] = await Promise.all([
-  repo.read.findMany((q) => {
-    q.pick(...cols).andWhere(pred).orderBy('createdAt', 'desc')
-    return q.limit(perPage).offset((page - 1) * perPage)
-  }),
-  repo.read.count(pred),
-])
-return { rows, total, page, perPage, totalPages: Math.ceil(total / perPage) }
+return repo.read.paginate(
+  { page, perPage },
+  q => q.pick(...cols).andWhere(pred).orderBy('createdAt', 'desc'),
+)
```

The count is branched off the same builder with the paging and ordering stripped, so a filter
added inside the callback is reflected in `total` - `data` and `total` always describe the same
row set. That was the reason the hand-rolled version existed.

`page` or `perPage` below `1` now throws `ValidationError` naming the argument. Previously `page: 0`
threw from `offset()` with a message about a negative offset, and `perPage: 0` returned
`totalPages: Infinity`. If you pass an unvalidated query-string value straight through, clamp it
before the call.

### 5. Soft-delete tables: `count`, `exists` and `paginate` can see trashed rows

```diff
-// count with trashed rows had to go through a hand-shaped builder
-const counted = await repo.read.findMany((q) => {
-  q.withTrashed()
-  for (const pred of predicates) q.andWhere(pred)
-  return q.count()
-})
-const total = Number((counted[0] as any)?.count ?? 0)
+const total = await repo.read.count(where, { withTrashed: true })
```

`exists()` also takes no argument now, matching `count()`.

### 6. Trait and column metadata is typed

```diff
-const meta = table.meta as Record<string, any> | undefined
-add(meta?.softDelete?.column)
-add(meta?.optimisticLock?.column)
-add(meta?.timestamps?.createdAt)
-add(meta?.timestamps?.updatedAt)
+import { traitColumns } from '@kaynooo/pg-orm'
+
+const managed = traitColumns(table)
```

`traitColumns` reports every column *any* trait added, custom traits included - `applyTrait` now
records them, so a project's own `orderable()` trait is covered without registering anything.

```diff
-// 'varchar(255)' -> 'varchar', 'int4[]' -> 'int4'
-const isArray = pgType.endsWith('[]')
-const base = pgType.replace(/\[\]$/, '').replace(/\(.*\)$/, '')
+import { columnBaseType } from '@kaynooo/pg-orm'
+
+const { base, isArray } = columnBaseType(col)
```

Also exported: `tableMeta(table)` (typed `softDelete` / `optimisticLock` / `timestamps` entries),
`hasTrait(table, name)`, and `writableColumns(table, { exclude })` - all columns except the primary
key, generated columns and trait-managed ones.

### 7. Things you can now delete

- **Your `repoCache` WeakMap.** `db.repo(table)` has been memoized per table definition for
  several releases; a wrapper around it is dead weight. `repo.using(tx)` is memoized per
  transaction client as of 4.5.0, so rebinding inside a loop is free too.
- **Hand-written `byIdWhere` / `scopedWhere` helpers** built out of `e => e.eq(pk, id)` - see
  sections 1 and 2.

---

## New API surface, at a glance

| | |
| --- | --- |
| `where` / `andWhere` / `whereAll` / `having` | also accept `{ col: value }` and `{ col: { op: value } }` |
| `compileWhere(input)` | compile either WHERE form to a tape, for generic composition |
| `read.findManyBy(where)`, `read.findOneBy(where)` | a find that is only a WHERE |
| `read.findById(id, cb?)` | the select callback is new |
| `read.findByIdOrThrow(id, cb?)`, `read.existsById(id)` | new |
| `write.updateById(id, set, opts?)`, `write.deleteById(id, opts?)` | new |
| `read.paginate(opts, cb?)` | the select callback is new; `total` follows it |
| `read.count(where?, { withTrashed })`, `read.exists(where?, { withTrashed })` | second argument is new; `exists` no longer requires a predicate |
| `read.paginate({ …, withTrashed })` | new |
| `tableMeta`, `hasTrait`, `traitColumns`, `writableColumns`, `columnBaseType` | new exports |
| `t.char(n)` | new column type (was documented but missing) |
| Types: `WhereInput`, `WhereObject`, `WhereOps`, `TrashedOptions`, `PaginateOptions`, `PaginateResult`, `PaginateCursorOptions`, `PaginateCursorResult`, `TableMeta` | new exports |

## Behaviour changes to check for

These are not breaking in the type sense - they change what happens at runtime for input that was
already wrong.

| before | after |
| --- | --- |
| `paginate({ page: 0, … })` threw `offset() requires a non-negative integer, got -20` | throws `ValidationError: paginate() requires page >= 1, got 0` - same class, a message that names the argument the caller passed |
| `paginate({ perPage: 0, … })` returned `totalPages: Infinity` | throws `ValidationError` |
| `table.meta` held `_appliedTraits` only | also holds `_traitColumns` |
| `repo.using(tx)` returned a fresh `Repository` per call | returns the same one per transaction client (the object identity changed; the behaviour did not) |

## Not in this release

Still open from `docs/consumer-driven-improvements.md`, in rough value order:

- **Relations by table def** - `r.hasMany(() => TierListTier, 'tier_list_id')` instead of a name
  string plus a hand-written generic, which can silently drift apart.
- **`includeCount`** - batched `GROUP BY` relation counts, currently done with `db.raw` plus a
  client-side `Map`.
- **Validation metadata on `ColumnDef`** - `.min/.max/.oneOf/.pattern` are recorded but not
  declared, so a framework deriving request schemas from a table loses every bound.
- **`tx.repo(Table)`** - shorter than `repo(X).using(tx)` per table inside a transaction body.
- **`groupBy` projecting its grouping columns** into the result type.
- **snake_case trait presets** - `timestamps()` contributes camelCase columns to otherwise
  snake_case tables, so raw SQL has to quote `"createdAt"`.
