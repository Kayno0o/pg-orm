# pg-ORM Feature Ideas & Gap Analysis

This document tracks confirmed bugs, incomplete features, and potential new features for `@kaynooo/pg-orm`. It is based on a static analysis of `src/`, `tests/`, `benchmarks/`, and project documentation, plus a successful run of the unit test suite.

---

## 1. Confirmed Bugs / Inconsistencies

### 1.1 Benchmark seeding is broken

**Files:** `benchmarks/schema.ts:88`, `benchmarks/schema.ts:109`

```ts
const inserted = await UserRepo.insertMany(batch)
userIds.push(...inserted.map(u => u.id))
```

`insertMany` returns an **array of primary keys** (`number[]`) by default, not full entity rows. Therefore `u.id` is `undefined` at runtime. The seed silently produces garbage `authorId` and `postId` values.

**Fix options:**
- Use the returned ids directly: `userIds.push(...inserted)`.
- Or pass `{ full: true }`: `const inserted = await UserRepo.insertMany(batch, { full: true })`.

**Why TypeScript missed it:** `insertMany` is implemented with a runtime return type of `Promise<any[]>`, so the `.id` access is not type-checked at the call site.

---

## 2. Incomplete / Partial Features

### 2.1 Runtime value validation is missing

**Files:** `src/schema/columns.ts:122-161`, `src/schema/column-meta.ts`, `src/repo/ops/insert-one.ts`, `src/repo/ops/update-many.ts`

The column builder exposes `.min()`, `.max()`, `.minLength()`, `.maxLength()`, `.pattern()`, and `.oneOf()`. These methods currently generate **DDL CHECK constraints** only (`src/migration/ddl.ts:48-75`). There is **no runtime validation** of insert/update values before the SQL is sent to PostgreSQL.

Values are only checked for `undefined`, non-finite numbers, and `__raw` markers in `validateValues()` (`src/builder/state.ts`).

**Impact:** Invalid values hit the database and surface as generic `CheckError` instead of clear, field-level `ValidationError` messages.

**Suggested direction:** Add a runtime validation pass inside the write operations that reads `getColumnMeta()` and enforces the same rules before SQL assembly.

---

### 2.2 Composite primary keys are half-supported

**Files:** `src/schema/table.ts:24-33`, `src/types/index.ts:202-207`, `src/repo/ops/insert-one.ts:14`, `src/repo/ops/insert-many.ts:17`, `src/repo/ops/find-one.ts:49-59`

| Area | Status |
|---|---|
| DDL generation | ✅ Supported — `generateCreateTable` emits `PRIMARY KEY (a, b)` |
| `findById` | ✅ Supported — splits `runtime.primaryKey` on commas |
| `insertOne` / `insertMany` return value | ❌ Broken — does `RETURNING "a,b"` and `rows[0][runtime.primaryKey]` |
| Type inference | ⚠️ Partial — `InferPrimaryKey<TColumns>` extracts only one column |

**Suggested direction:** Detect composite PKs in write ops and return `{ a, b }` objects. Update `InferPrimaryKey<TColumns>` to return an object type when multiple primary-key columns exist.

---

### 2.3 Composite foreign keys are not supported

**Files:** `src/schema/columns.ts:164-178`, `src/types/index.ts:53-58`, `src/migration/diff/foreign-keys.ts`

`.references()` accepts exactly one target column:

```ts
references(() => otherTable, 'otherId')
```

PostgreSQL supports multi-column foreign keys (`FOREIGN KEY (a, b) REFERENCES t (x, y)`), but the API, the `ForeignKeyRef` type, and the migration diff logic cannot express them.

**Suggested direction:** Allow `.references(() => table, ['a', 'b'])` and update DDL/diff/introspection accordingly.

---

### 2.4 Lateral joins are internal-only

**File:** `src/builder/select.ts`

The assembler/state understands join `type: 'lateral'`, but `SelectBuilder` only exposes:

- `join`
- `leftJoin`
- `rightJoin`
- `fullJoin`

There is no public `lateralJoin()` method.

**Suggested direction:** Add `lateralJoin(table, alias, on)` and `leftLateralJoin(table, alias, on)` methods to `SelectBuilder`.

---

### 2.5 Upsert has no `DO NOTHING` path

**File:** `src/builder/upsert.ts`

`UpsertBuilder` supports:

- `onConflict(...cols)`
- `doUpdate(...cols)`

It does not support `ON CONFLICT DO NOTHING`.

**Suggested direction:** Add `doNothing()` method.

---

### 2.6 Relations have no cascade options

**File:** `src/schema/relations.ts`

Relations are purely navigational. Cascade behavior (`onDelete`, `onUpdate`) exists only on column-level `.references()`. There is no relation-level `onDelete: 'cascade'` that could auto-generate the FK constraint.

---

## 3. Missing Features vs. Typical ORMs

| Feature | Status | Notes |
|---|---|---|
| **Seeding framework** | Missing | Tests and examples seed manually with `insertMany`. |
| **Migration CLI / file writer** | Missing | `generateMigration()` returns `{ name, up, down }` strings only. No filesystem write or CLI runner. |
| **Query scopes** | Missing | No reusable named `where` fragments on repositories. |
| **Entity / query cache** | Missing | No opt-in memory cache or invalidation hooks. |
| **DataLoader-style batching** | Missing | No general per-request batch loader beyond relation `include()`. |
| **Polymorphic relations** | Missing | No `morphTo` / `morphMany` relation type. |
| **Model classes / instance methods** | Missing | Table definitions are plain objects, not classes. |
| **Plugin / event emitter system** | Missing | Only lifecycle hooks; no general plugin architecture. |
| **`VALUES` list builder** | Missing | No dedicated `VALUES (...)` constructor for arbitrary value sets. |
| **`COPY FROM/TO` bulk load** | Missing | No PostgreSQL `COPY` support. |
| **Partial unique indexes** | Partial | `withIndexes` supports `where`, but columns cannot declare `.unique({ where })`. |
| **Exclusion constraints** | Missing | No `EXCLUDE` constraint support. |
| **Read replicas / routing** | Missing | Single connection URL only. |
| **Built-in observability metrics** | Missing | No counters/histograms for queries, errors, or pool stats. |
| **Schema snapshots** | Missing | No versioned JSON snapshots for offline diffing. |
| **Field name mapping** | Intentionally missing | Documented in README; no automatic `camelCase` ↔ `snake_case` conversion. |

---

## 4. New Feature Ideas

The project is currently in a production-readiness phase (see `CHANGELOG.md` v4). The best opportunities are small, correctness-focused additions rather than major architectural changes.

### 4.1 High-value, low-risk

#### Runtime validation layer

Enforce `.min`, `.max`, `.minLength`, `.maxLength`, `.pattern`, and `.oneOf` on insert/update values before SQL is built. Throw typed `ValidationError` with field names.

**Rationale:** Reuses existing metadata, improves error messages, and prevents unnecessary DB round-trips.

#### Fix composite PK support in write ops

Make `insertOne`/`insertMany` detect comma-separated `runtime.primaryKey` and return an object `{ a, b }` instead of `rows[0]["a,b"]`.

**Rationale:** A feature that partially works is worse than one that does not exist. This closes a correctness gap.

#### Add `doNothing()` to `UpsertBuilder`

Support `ON CONFLICT (...) DO NOTHING`.

**Rationale:** Small API completeness win; common pattern for idempotent inserts.

#### Expose `lateralJoin()`

The assembler already understands lateral joins. Add public builder methods.

**Rationale:** Low effort, unlocks powerful PostgreSQL features like `LATERAL` subqueries in joins.

#### Fix benchmark seeding

One-line fix to make performance benchmarks produce valid data.

**Rationale:** Trivial correctness fix for the benchmark suite.

---

### 4.2 Medium-value additions

#### Composite foreign keys

Extend `.references()` to accept arrays of columns and update the diff/introspection logic.

**Rationale:** Needed for proper relational modeling of tables with natural multi-column keys.

#### Query scopes

Allow reusable, named filters on repositories:

```ts
const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  status: t.text().notNull(),
  createdAt: t.timestamp().notNull(),
}))
  .withScopes({
    active: q => q.where(e => e.eq('status', 'active')),
    recent: q => q.where(e => e.gt('createdAt', Date.now() - 86400000)),
  })

await UserRepo.read.findMany(['active', 'recent'])
```

**Rationale:** Reduces repetition and improves query consistency.

#### Partial unique indexes at column level

Allow:

```ts
text('email').unique({ where: 'deleted_at IS NULL' })
```

**Rationale:** Common pattern for soft-deleted tables; currently requires `withIndexes()`.

#### Seeding framework

Add `db.seed(seedFn)` or a standalone `seed()` helper that:

- Runs inside a transaction.
- Tracks applied seeds in a `_pgorm_seeds` table.
- Is idempotent.

**Rationale:** Every project needs seed data; a built-in helper reduces boilerplate.

#### Type-safe raw query mapper

Allow raw queries to reuse a table's JIT mapper:

```ts
const rows = await db.rawMapped(users, 'SELECT * FROM users WHERE id > $1', [10])
```

**Rationale:** Bridges the gap between raw SQL and the ORM's typed result mapping.

---

### 4.3 Bigger architectural ideas

#### Plugin / extension system

A small registry of `(db, table) => void` plugins. Examples:

- Automatic audit columns.
- Automatic tenant scoping.
- Custom trait packs.

#### Query result cache

Opt-in per-query cache with TTL and tag-based invalidation. Must integrate cleanly with hooks so mutations can invalidate cached reads.

#### Read replica routing

Allow `Database` to accept a `readUrl` and route reads to replicas while writes go to the primary.

#### Built-in observability metrics

Emit events for query count, duration, errors, and pool stats. Users can wire these to Prometheus, OpenTelemetry, or custom dashboards.

#### Migration CLI

A `pg-orm migrate` command that:

- Writes migration files from `generateMigration()`.
- Applies pending migrations.
- Rolls back migrations by count.
- Shows drift status.

---

## 5. Recommended Priority Order

To stay aligned with the project's minimal, production-ready direction:

1. **Fix benchmark seeding** — trivial correctness fix.
2. **Runtime validation** — closes a real gap between schema metadata and user-facing errors.
3. **Fix composite PK write returns** — completes an advertised but broken feature.
4. **Add `doNothing()` upsert** — small API completeness win.
5. **Expose lateral joins** — reuses existing internals.
6. **Composite FKs** — medium effort, needed for correct relational modeling.
7. **Scopes or seeding** — pick based on user pain points.

---

## 6. How to Contribute

When implementing items from this list:

- Keep changes minimal and focused.
- Add unit tests for builder/state changes.
- Add integration tests for runtime/database-affecting changes.
- Update `README.md` if the public API changes.
- Update this file to mark completed items as done.
