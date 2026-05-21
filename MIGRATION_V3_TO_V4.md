# Migration Guide: v3 → v4

v4 splits `Repository` into three lazy operation suites: **`read`**, **`write`**, and **`stream`**. Every method that used to live on `Repository` directly now lives on one of these suites. Migration is mechanical — a call-site rename — and can be done with the `sed` one-liner at the bottom of this guide.

No constructor changes, no schema changes, no error-handling changes. `db.repo(table)` still returns a `Repository`; only the way you call methods on it has moved.

---

## Table of Contents

1. [Overview](#overview)
2. [Why](#why)
3. [Read methods](#read-methods)
4. [Write methods](#write-methods)
5. [Stream methods](#stream-methods)
6. [Builder accessors](#builder-accessors)
7. [Transactions](#transactions)
8. [Batch migration](#batch-migration)
9. [Rollout checklist](#rollout-checklist)

---

## Overview

| v3 | v4 |
|---|---|
| `repo.findMany(...)` | `repo.read.findMany(...)` |
| `repo.findOne(...)` | `repo.read.findOne(...)` |
| `repo.findOneOrThrow(...)` | `repo.read.findOneOrThrow(...)` |
| `repo.findById(id)` | `repo.read.findById(id)` |
| `repo.count(...)` | `repo.read.count(...)` |
| `repo.exists(...)` | `repo.read.exists(...)` |
| `repo.paginate({...})` | `repo.read.paginate({...})` |
| `repo.paginateCursor({...})` | `repo.read.paginateCursor({...})` |
| `repo.select()` | `repo.read.select()` |
| `repo.insertOne(...)` | `repo.write.insertOne(...)` |
| `repo.insertMany(...)` | `repo.write.insertMany(...)` |
| `repo.updateOne(...)` | `repo.write.updateOne(...)` |
| `repo.updateMany(...)` | `repo.write.updateMany(...)` |
| `repo.updateWithLock(...)` | `repo.write.updateWithLock(...)` |
| `repo.deleteOne(...)` | `repo.write.deleteOne(...)` |
| `repo.deleteMany(...)` | `repo.write.deleteMany(...)` |
| `repo.upsertMany(...)` | `repo.write.upsertMany(...)` |
| `repo.findOrCreate(...)` | `repo.write.findOrCreate(...)` |
| `repo.restore(...)` | `repo.write.restore(...)` |
| `repo.forceDelete(...)` | `repo.write.forceDelete(...)` |
| `repo.insert()` (builder) | `repo.write.insert()` |
| `repo.update()` (builder) | `repo.write.update()` |
| `repo.delete()` (builder) | `repo.write.delete()` |
| `repo.merge()` (builder) | `repo.write.merge()` |
| `repo.upsert()` (builder) | `repo.write.upsert()` |
| `repo.stream(...)` | `repo.stream.stream(...)` |
| `repo.streamCursor(...)` | `repo.stream.streamCursor(...)` |
| `repo.using(tx)` | `repo.using(tx)` — **unchanged** |

---

## Why

`Repository` had ~30 public methods on a single class. The split:

- **Clarifies intent at the call site** — `repo.write.insertOne(...)` reads as "this mutates" without needing to know which methods write.
- **Defers allocation** — the relation loader (used by reads), hook orchestrator (used by writes), and stream warning state only materialize for the suites you actually touch.
- **Cuts the surface per suite** — each suite is ~150–300 LOC instead of one ~700-line class.

---

## Read methods

### Before (v3)

```ts
const users = await UserRepo.findMany(q => q.where(e => e.eq('active', true)))
const alice = await UserRepo.findOne(q => q.where(e => e.eq('email', 'alice@test.com')))
const total = await UserRepo.count()
const page  = await UserRepo.paginate({ page: 1, perPage: 20 })
```

### After (v4)

```ts
const users = await UserRepo.read.findMany(q => q.where(e => e.eq('active', true)))
const alice = await UserRepo.read.findOne(q => q.where(e => e.eq('email', 'alice@test.com')))
const total = await UserRepo.read.count()
const page  = await UserRepo.read.paginate({ page: 1, perPage: 20 })
```

`paginateCursor`, `findById`, `findOneOrThrow`, `exists`, and `select()` move identically.

---

## Write methods

### Before (v3)

```ts
const id = await UserRepo.insertOne({ name: 'Alice', email: 'alice@test.com' })
await UserRepo.updateOne({ name: 'Updated' }, e => e.eq('id', id))

// Optimistic lock
await VersionedRepo.updateWithLock(
  { value: 42 },
  e => e.eq('id', 1),
  currentVersion,
)

// Soft-delete recovery
await UserRepo.restore(e => e.eq('id', deletedId))
await UserRepo.forceDelete(e => e.lt('createdAt', cutoff))
```

### After (v4)

```ts
const id = await UserRepo.write.insertOne({ name: 'Alice', email: 'alice@test.com' })
await UserRepo.write.updateOne({ name: 'Updated' }, e => e.eq('id', id))

// Optimistic lock
await VersionedRepo.write.updateWithLock(
  { value: 42 },
  e => e.eq('id', 1),
  currentVersion,
)

// Soft-delete recovery
await UserRepo.write.restore(e => e.eq('id', deletedId))
await UserRepo.write.forceDelete(e => e.lt('createdAt', cutoff))
```

---

## Stream methods

### Before (v3)

```ts
for await (const row of UserRepo.stream()) { … }
for await (const row of UserRepo.stream(q => q.where(e => e.eq('active', true)), { chunkSize: 500 })) { … }
for await (const row of UserRepo.streamCursor({ chunkSize: 500 })) { … }
```

### After (v4)

```ts
for await (const row of UserRepo.stream.stream()) { … }
for await (const row of UserRepo.stream.stream(q => q.where(e => e.eq('active', true)), { chunkSize: 500 })) { … }
for await (const row of UserRepo.stream.streamCursor({ chunkSize: 500 })) { … }
```

Yes — `repo.stream.stream(...)` reads a bit redundant. `repo.stream` is the suite getter; `repo.stream.stream()` invokes the async iterator on it. The suite also exposes `streamCursor`, so the doubled name is the price of consistency with `repo.read.find*` and `repo.write.insert*`.

---

## Builder accessors

The advanced builder accessors (for ad-hoc SQL the convenience methods don't cover) move with their natural suite:

```ts
// v3
const sb = repo.select()            // SELECT builder, soft-delete auto-applied
const ib = repo.insert()            // INSERT builder
const ub = repo.update()            // UPDATE builder
const db = repo.delete()            // DELETE builder
const mb = repo.merge()             // MERGE builder
const ub = repo.upsert()            // UPSERT builder

// v4
const sb = repo.read.select()
const ib = repo.write.insert()
const ub = repo.write.update()
const db = repo.write.delete()
const mb = repo.write.merge()
const ub = repo.write.upsert()
```

---

## Transactions

`repo.using(tx)` is **unchanged**. It still returns a `Repository`. Suite access is one extra hop:

### Before (v3)

```ts
await db.transaction(async (tx) => {
  const txRepo = UserRepo.using(tx)
  await txRepo.insertOne({ name: 'Alice', email: 'a@test.com' })
  const found = await txRepo.findOne(q => q.where(e => e.eq('email', 'a@test.com')))
})
```

### After (v4)

```ts
await db.transaction(async (tx) => {
  const txRepo = UserRepo.using(tx)
  await txRepo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
  const found = await txRepo.read.findOne(q => q.where(e => e.eq('email', 'a@test.com')))
})
```

---

## Batch migration

The migration is purely a call-site rewrite — no semantic changes. From the project root, run the following one-liner. It's the same script used to migrate this repo's ~177 integration tests:

```bash
find src tests examples -name '*.ts' -print0 | xargs -0 sed -i -E \
  -e 's/\.(findMany|findOne|findOneOrThrow|findById|count|exists|paginate|paginateCursor)\(/.read.\1(/g' \
  -e 's/\.(insertOne|insertMany|updateOne|updateMany|updateWithLock|deleteOne|deleteMany|upsertMany|findOrCreate|restore|forceDelete)\(/.write.\1(/g' \
  -e 's/\.streamCursor\(/.stream.streamCursor(/g' \
  -e 's/\.stream\(/.stream.stream(/g' \
  -e 's/\.select\(\)/.read.select()/g' \
  -e 's/\.(insert|update|delete|merge|upsert)\(\)/.write.\1()/g'
```

### Known false positives

`SelectBuilder` exposes `.count()`, `.exists(...)`, and `.select(...)` — these are **not** Repository methods and the rewrite will mistakenly add `.read.` to them. After running the script, search for and revert:

```bash
grep -rn '\.read\.\(count\|exists\|select\)(' src tests examples
```

Common cases:
- `expr.exists(subquery)` (EXISTS subquery on `ExprBuilder`)
- `selectBuilder.count()` (turns a SELECT into `SELECT count(*)`)

These are usually a handful per project.

---

## Rollout checklist

- [ ] Bump `@kaynooo/pg-orm` to v4 in `package.json`
- [ ] Run the `sed` script in the project root
- [ ] `grep -rn 'repo\.\(findMany\|insertOne\|stream\)\b' src tests examples` should return zero matches
- [ ] Fix any builder false positives flagged above
- [ ] `tsc --noEmit` should be green
- [ ] Run your test suite end-to-end
- [ ] Update any inline `repo.X()` references in docs/comments

That's it. No schema, error, or transaction semantics changed.
