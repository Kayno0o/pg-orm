# pg-ORM Feature Ideas & Gap Analysis

This document tracks confirmed bugs, incomplete features, and potential new features for `@kaynooo/pg-orm`. Last audited against v4 source.

---

## 1. Confirmed Bugs / Inconsistencies

### ~~1.1 Benchmark seeding is broken~~ ✅ Fixed

`insertMany` returns `number[]` by default. Was calling `.map(u => u.id)` on the numbers. Fixed to `userIds.push(...inserted)` / `postIds.push(...inserted)` directly.

---

## 2. Incomplete / Partial Features

### 2.1 Runtime value validation is missing

**Files:** `src/schema/columns.ts`, `src/repo/write-pipeline.ts`

`.min()`, `.max()`, `.minLength()`, `.maxLength()`, `.pattern()`, `.oneOf()` generate DDL CHECK constraints only. No runtime validation before SQL is sent.

Note: `src/schema/validate.ts` exists but covers identifier safety and raw SQL fragment checks — not column value constraints.

**Impact:** Invalid values hit the database and surface as `CheckError` instead of typed `ValidationError` with field names.

**Direction:** Runtime validation pass in write ops, reading column meta before SQL assembly.

---

### 2.2 Composite primary keys are half-supported

**Files:** `src/repo/write-pipeline.ts:264-288`

| Area | Status |
|---|---|
| DDL generation | ✅ Supported |
| `findById` | ✅ Supported |
| `insertOne` / `insertMany` return value | ❌ Broken — `rows[0]![this._runtime.primaryKey]` on a comma-joined string key |
| Type inference | ⚠️ Partial |

**Direction:** Detect composite PKs in write ops and return `{ a, b }` objects.

---

### 2.3 Composite foreign keys are not supported

**Files:** `src/schema/columns.ts`, `src/migration/diff/foreign-keys.ts`

`.references()` accepts exactly one target column. No multi-column FK support in API, types, or diff logic.

**Direction:** Allow `.references(() => table, ['a', 'b'])`.

---

### 2.4 Lateral joins are internal-only

**Files:** `src/builder/state.ts:18`, `src/builder/assembler.ts:160`

The state/assembler understand `type: 'lateral'` but `SelectBuilder` only exposes `join`, `leftJoin`, `rightJoin`, `fullJoin`. No public `lateralJoin()` or `leftLateralJoin()`.

**Direction:** Add the two public methods — the assembler already handles the rest.

---

### 2.5 UpsertBuilder has no `DO NOTHING` path

**File:** `src/builder/upsert.ts`

`InsertBuilder` gained `.doNothing()` (`src/builder/insert.ts:43`). `UpsertBuilder` still does not have it.

**Direction:** Add `doNothing()` to `UpsertBuilder` — assembler already emits `ON CONFLICT (...) DO NOTHING`.

---

### 2.6 Relations have no cascade options

**File:** `src/schema/relations.ts`

Relations are purely navigational. Cascade behavior exists only on column-level `.references()`. No relation-level `onDelete` / `onUpdate` that auto-generates the FK constraint.

---

## 3. Missing Features vs. Typical ORMs

| Feature | Status | Notes |
|---|---|---|
| **Seeding framework** | Missing | Projects seed manually with `insertMany`. |
| **Migration CLI** | Missing | `interactive.ts` is TTY confirmation for `db.sync({ confirm: true })`, not a file-writing CLI. `generateMigration()` returns strings only. |
| **Query scopes** | Missing | No reusable named `where` fragments on repositories. |
| **Entity / query cache** | Missing | No opt-in memory cache or invalidation hooks. |
| **DataLoader-style batching** | Missing | No general per-request batch loader beyond relation `include()`. |
| **Polymorphic relations** | Missing | No `morphTo` / `morphMany`. |
| **Model classes / instance methods** | Missing | Table definitions are plain objects, not classes. |
| **Plugin / event emitter system** | Missing | Only lifecycle hooks; no general plugin architecture. |
| **`COPY FROM/TO` bulk load** | Missing | No PostgreSQL `COPY` support. |
| **Partial unique indexes (column-level)** | Partial | `withIndexes` supports `where`; columns cannot declare `.unique({ where })`. |
| **Exclusion constraints** | Missing | No `EXCLUDE` constraint support. |
| **Read replicas / routing** | Missing | Single connection URL only. |
| **Built-in observability metrics** | Missing | No counters/histograms for queries, errors, or pool stats. |
| **Schema snapshots** | Missing | No versioned JSON snapshots for offline diffing. |
| **Type-safe raw query mapper** | Missing | No `db.rawMapped(table, sql, params)` to reuse JIT mapper for raw queries. |
| **Field name mapping** | Intentionally missing | No automatic `camelCase` ↔ `snake_case` conversion. |

---

## 4. New Feature Ideas

### 4.1 High-value, low-risk

#### Fix benchmark seeding
One-line fix. See §1.1.

#### Runtime validation layer
Enforce column constraints on insert/update before SQL is built. Throw `ValidationError` with field names. Reuses existing metadata.

#### Fix composite PK write returns
Make `insertOne`/`insertMany` detect composite PKs and return `{ a, b }` objects. See §2.2.

#### Add `doNothing()` to `UpsertBuilder`
Assembler already supports it. See §2.5.

#### Expose `lateralJoin()` / `leftLateralJoin()`
Two public methods, assembler already handles emission. See §2.4.

---

### 4.2 Medium-value additions

#### Composite foreign keys
Extend `.references()` to accept column arrays. Update DDL/diff/introspection.

#### Query scopes
Named reusable filters on repositories:
```ts
defineTable('users', t => ({ ... })).withScopes({
  active: q => q.where(e => e.eq('status', 'active')),
})
await UserRepo.read.findMany({ scope: 'active' })
```

#### Partial unique indexes at column level
```ts
text('email').unique({ where: 'deleted_at IS NULL' })
```
Currently requires `withIndexes()`.

#### Type-safe raw query mapper
```ts
const rows = await db.rawMapped(users, 'SELECT * FROM users WHERE id > $1', [10])
```
Bridges raw SQL and the JIT mapper.

---

### 4.3 Bigger architectural ideas

#### Plugin / extension system
Registry of `(db, table) => void` plugins — audit columns, tenant scoping, custom trait packs.

#### Query result cache
Opt-in per-query cache with TTL and tag-based invalidation, integrated with write hooks.

#### Read replica routing
Accept `readUrl`, route reads to replicas, writes to primary.

#### Built-in observability metrics
Emit events for query count, duration, errors, pool stats. Wire to Prometheus / OpenTelemetry.

#### Migration CLI
`pg-orm migrate` command that writes migration files, applies/rolls back pending migrations, shows drift status.

---

## 5. Recommended Priority Order

1. **Fix benchmark seeding** — trivial.
2. **Runtime validation** — closes the gap between schema metadata and user-facing errors.
3. **Fix composite PK write returns** — completes an advertised but broken feature.
4. **Add `doNothing()` to UpsertBuilder** — small API completeness win.
5. **Expose lateral joins** — reuses existing internals, zero assembler work.
6. **Composite FKs** — medium effort, needed for correct relational modeling.
7. **Type-safe raw query mapper** — useful bridge for complex queries.
8. **Scopes or seeding** — pick based on user pain points.
