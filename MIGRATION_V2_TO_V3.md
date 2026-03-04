# Migration Guide: v2 → v3

v3 is a **complete rewrite**. The public API is fundamentally different — not just renamed but restructured. Plan to rewrite all schema definitions, repository usage, and error handling.

---

## Table of Contents

1. [Overview of changes](#overview-of-changes)
2. [Installation](#installation)
3. [Schema definition](#schema-definition)
4. [Database connection](#database-connection)
5. [Repositories](#repositories)
6. [Query API](#query-api)
7. [Relations](#relations)
8. [Virtuals](#virtuals)
9. [Traits](#traits)
10. [Hooks](#hooks)
11. [Transactions](#transactions)
12. [Migrations](#migrations)
13. [Error handling](#error-handling)
14. [Removed features](#removed-features)

---

## Overview of changes

| Concept | v2 | v3 |
|---|---|---|
| Schema definition | `orm.entity(name, f => ({...}))` → `EntityBuilder` | `defineTable(name, t => ({...}))` |
| Entry point | `new ORM()` | `new Database(config)` |
| Get a repository | `orm.repo(entityDef)` | `db.repo(tableDef)` |
| Column API | `field.string()`, `field.number()`, … | `t.text()`, `t.int4()`, `t.serial()`, … |
| Field nullability | `.nullable()` / `.required()` | `.nullable()` / `.notNull()` |
| Traits | `createTrait()` builder chain | Plain `Trait` object `{ columns, hooks, virtuals, meta }` |
| Apply traits | `.useTrait(myTrait)` on `EntityBuilder` | `.withTrait(myTrait)` on `TableDef` |
| Built-in traits | `timestamps`, `softDelete`, `paranoid`, `uuidPrimary`, `sluggable`, `publishable`, `sortable`, `versionable` | `timestamps()`, `softDelete()`, `optimisticLock()` |
| Transactions | `repo.transaction(cb)` | `db.transaction(opts?, cb)` + `repo.using(tx)` |
| Soft delete recovery | via trait method | `repo.restore(where)` / `repo.forceDelete(where)` |
| Optimistic lock | `versionable` trait + manual | `optimisticLock()` trait + `repo.updateWithLock()` |
| Error classes | flat namespace | hierarchy under `OrmError` |
| Cache | `CacheAdapter` on `ORM` | removed |
| Query logger | `queryLogger.configure(...)` | `onQuery` / `onSlowQuery` callbacks on `DbConfig` |
| Seeder | `SeederRunner` / `defineFactory` | removed |
| Query builder `where` | `.where(field, op, value)` | `.where(e => e.eq('field', value))` |

---

## Installation

No package rename — still `@kaynooo/pg-orm`. Just bump the version.

---

## Schema definition

### v2

```ts
import { ORM } from '@kaynooo/pg-orm'

const orm = new ORM()

const UserEntity = orm.entity('users', f => ({
  name: f.string().maxLength(100).toConfig(),
  email: f.string().unique().toConfig(),
  age: f.number().nullable().toConfig(),
  role: f.enum(['admin', 'user']).default('user').toConfig(),
  createdAt: f.timestamp().toConfig(),
})).build()
```

### v3

```ts
import { defineTable } from '@kaynooo/pg-orm'

const users = defineTable('users', t => ({
  id:        t.serial().primaryKey(),
  name:      t.varchar(100).notNull(),
  email:     t.text().notNull().unique(),
  age:       t.int4().nullable(),
  role:      t.enum('user_role', ['admin', 'user']).notNull().default("'user'"),
  createdAt: t.timestamptz().notNull().default('now()'),
}))
```

**Key differences:**

- Column types are now explicit PostgreSQL types (`text`, `varchar(n)`, `int4`, `serial`, `uuid`, `timestamptz`, `jsonb`, …) instead of abstract JS types.
- `primaryKey()` must be explicitly declared — there is no implicit `id` column.
- `default()` takes a **SQL expression string** (`"'user'"`, `'now()'`, `'gen_random_uuid()'`), not a JS value.
- `unique()` is still a method on the builder.
- `nullable()` / `notNull()` replaces `nullable()` / `required()`.
- Enum types require a **PG type name** as the first argument.

### Column type mapping

| v2 field | v3 column type |
|---|---|
| `f.string()` | `t.text()` or `t.varchar(n)` |
| `f.number()` | `t.int4()` / `t.int8()` / `t.float8()` / `t.numeric()` |
| `f.number().integer()` | `t.int4()` |
| `f.boolean()` | `t.boolean()` |
| `f.uuid()` | `t.uuid()` |
| `f.timestamp()` | `t.timestamptz()` or `t.timestamp()` |
| `f.date()` | `t.date()` |
| `f.json()` / `f.jsonb()` | `t.json()` / `t.jsonb()` |
| `f.array('string')` | `t.array(t.text())` |
| `f.array('number')` | `t.array(t.int4())` |
| `f.enum(['a','b'])` | `t.enum('type_name', ['a', 'b'])` |
| `f.blob()` | `t.bytea()` |
| Foreign key (number field with `.foreignKey(...)`) | `t.int4().references(() => otherTable, 'id')` |

### Composite unique constraints and indexes

```ts
// v2 — on EntityBuilder
const Entity = orm.entity('posts', f => ({...}))
  .unique(['authorId', 'slug'])
  .build()

// v3 — on TableDef
const posts = defineTable('posts', t => ({
  authorId: t.int4().notNull(),
  slug:     t.text().notNull(),
}))
  .withIndexes([{ columns: ['authorId', 'slug'], unique: true }])
```

---

## Database connection

### v2

```ts
const orm = new ORM({ logging: { enabled: true } })

await orm.connect({
  connectionString: 'postgres://user:pass@localhost:5432/mydb',
  poolMax: 10,
  schema: 'myschema',
  migrations: { directory: './migrations', autoMigrate: true },
})

// later
await orm.disconnect()
```

### v3

```ts
import { Database } from '@kaynooo/pg-orm'

const db = new Database({
  url: 'postgres://user:pass@localhost:5432/mydb',
  pool: { max: 10 },
  schema: 'myschema',
  tables: [users, posts, comments], // register all tables upfront for relation resolution
  onQuery: (event) => console.log(event.sql, event.durationMs),
  onSlowQuery: (event) => console.warn('Slow query:', event.sql),
  slowQueryThreshold: 500,
})

// later
await db.close()
```

**Key differences:**

- `new Database(config)` is synchronous — no `await connect()`.
- Pass `tables` array upfront so the repository can resolve relations.
- Query logging is `onQuery` / `onSlowQuery` callbacks instead of a `queryLogger` singleton.
- `connectionString` → `url`.
- Pool options are nested under `pool: { max, idleTimeout, maxLifetime, connectionTimeout }`.
- `ssl` → `tls`.
- Auto-migration is gone — use `db.sync()` explicitly (see [Migrations](#migrations)).

---

## Repositories

### v2

```ts
const repo = orm.repo(UserEntity)

// CRUD
const user  = await repo.find(1)
const all   = await repo.findAll()
const user  = await repo.create({ name: 'Alice', email: 'a@x.com' })
await repo.update(1, { name: 'Bob' })
await repo.delete(1)
await repo.createMany([...])
await repo.deleteMany([1, 2, 3])
const n     = await repo.count()
const found = await repo.exists(1)
```

### v3

```ts
const repo = db.repo(users)

// CRUD
const user  = await repo.findById(1)
const all   = await repo.findMany()
const user  = await repo.insertOne({ name: 'Alice', email: 'a@x.com' })
await repo.updateMany({ name: 'Bob' }, e => e.eq('id', 1))
await repo.deleteMany(e => e.eq('id', 1))
await repo.insertMany([...])
const n     = await repo.count()
const found = await repo.exists(e => e.eq('id', 1))
```

### Method mapping

| v2 | v3 |
|---|---|
| `find(id)` | `findById(id)` |
| `findAll()` | `findMany()` |
| `create(data)` | `insertOne(data)` |
| `update(id, data)` | `updateOne(data, e => e.eq('id', id))` |
| `delete(id)` | `deleteOne(e => e.eq('id', id))` |
| `createMany(data[])` | `insertMany(data[])` |
| `deleteMany(ids[])` | `deleteMany(e => e.in('id', ids))` |
| `count()` | `count()` |
| `exists(id)` | `exists(e => e.eq('id', id))` |
| `repo.transaction(cb)` | `db.transaction(async tx => { const r = repo.using(tx); ... })` |
| `repo.scope('name')` | removed (use query callbacks) |
| n/a | `findOne(cb?)` |
| n/a | `findOneOrThrow(cb?)` |
| n/a | `updateWithLock(data, where)` |
| n/a | `upsertMany(rows)` |
| n/a | `findOrCreate(where, defaults)` |
| n/a | `paginate({ page, perPage, where? })` |
| n/a | `paginateCursor({ take, cursor?, where? })` |
| n/a | `stream({ chunkSize?, where? })` |
| n/a | `streamCursor({ chunkSize?, where? })` |
| n/a | `restore(where)` (soft delete) |
| n/a | `forceDelete(where)` (soft delete bypass) |

---

## Query API

v3 uses an **expression builder** function instead of method chaining with field/op/value arguments.

### v2

```ts
const repo = orm.repo(UserEntity)

// Building a query through the repository
const users = await repo.findAll()

// The QueryBuilder was accessed via scope or internal methods
// Where was: .where(field, op, value)
// e.g., inside a scope:
const Entity = orm.entity('users', f => ({...}))
  .scope('admins', q => q.where('role', '=', 'admin'))
  .build()
```

### v3

```ts
const repo = db.repo(users)

// All find methods accept an optional query builder callback
const admins = await repo.findMany(q =>
  q.where(e => e.eq('role', 'admin'))
   .orderBy('name', 'asc')
   .limit(10)
)

const one = await repo.findOne(q =>
  q.where(e => e.and(
    e.eq('email', 'a@x.com'),
    e.eq('active', true),
  ))
)
```

### Expression builder operators

| v2 operator | v3 expression |
|---|---|
| `'='` | `e.eq('col', val)` |
| `'!='` | `e.ne('col', val)` |
| `'>'` | `e.gt('col', val)` |
| `'>='` | `e.gte('col', val)` |
| `'<'` | `e.lt('col', val)` |
| `'<='` | `e.lte('col', val)` |
| `'LIKE'` | `e.like('col', '%val%')` |
| `'ILIKE'` | `e.ilike('col', '%val%')` |
| `'IN'` | `e.in('col', [...])` |
| `'NOT IN'` | `e.notIn('col', [...])` |
| `'IS NULL'` | `e.isNull('col')` |
| `'IS NOT NULL'` | `e.isNotNull('col')` |
| `.where(...).where(...)` (AND) | `e.and(e.eq(...), e.eq(...))` or `.andWhere(fn)` |
| `.orWhere(...)` | `e.or(e.eq(...), e.eq(...))` |
| `.whereGroup(cb)` | `e.and(...)` / `e.or(...)` with nesting |

### Query builder method mapping

| v2 QueryBuilder | v3 SelectBuilder |
|---|---|
| `.where(field, op, value)` | `.where(e => e.eq('field', value))` |
| `.orWhere(field, op, value)` | `.where(e => e.or(...))` |
| `.whereGroup(cb)` | `.where(e => e.and(...))` |
| `.select(fields[])` | `.pick(...cols)` |
| `.orderBy(field, dir)` | `.orderBy('col', 'asc'\|'desc')` |
| `.limit(n)` | `.limit(n)` |
| `.offset(n)` | `.offset(n)` |
| `.join(table, type, on)` | `.join(table, alias, e => e.eq(...))` / `.leftJoin(...)` |
| `.groupBy(fields[])` | `.groupBy(...cols)` |
| n/a | `.having(fn)` |
| n/a | `.include('relation', cb?)` |
| n/a | `.withTrashed()` |
| n/a | `.distinct()` |
| n/a | `.aggregate({ alias: 'expr' })` |
| n/a | `.count()` |
| n/a | `.with(name, sql, params)` (CTEs) |
| n/a | `.window(name, opts)` |
| n/a | `.skipLocked()` |
| n/a | `.toSQL()` |
| n/a | `.explain({ analyze? })` |

---

## Relations

Relations no longer exist in v2 (they were removed in 2.1). In v3 they are a first-class feature.

```ts
import { defineTable } from '@kaynooo/pg-orm'

const users = defineTable('users', t => ({
  id:   t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const posts = defineTable('posts', t => ({
  id:       t.serial().primaryKey(),
  authorId: t.int4().notNull().references(() => users, 'id', { onDelete: 'CASCADE' }),
  title:    t.text().notNull(),
}), r => ({
  author: r.belongsTo(users, 'authorId'),
}))

users.withRelations(r => ({
  posts: r.hasMany(posts, 'authorId'),
}))

// Loading relations (no N+1 — batch loaded)
const postsWithAuthors = await db.repo(posts).findMany(q =>
  q.include('author')
)

const usersWithPosts = await db.repo(users).findMany(q =>
  q.include('posts', q => q.orderBy('title'))
)
```

---

## Virtuals

### v2

Virtuals were defined as methods on the `EntityBuilder`:

```ts
const Entity = orm.entity('posts', f => ({
  title: f.string().toConfig(),
  body:  f.string().toConfig(),
}))
  .virtual('excerpt', (entity) => entity.body.slice(0, 100))
  .build()
```

### v3

Virtuals are a 4th argument to `defineTable` (or added via `.withVirtuals()`):

```ts
const posts = defineTable('posts', t => ({
  title: t.text().notNull(),
  body:  t.text().notNull(),
}), r => ({}), {
  excerpt: (row) => row.body.slice(0, 100),
})

// Or added after definition:
posts.withVirtuals({
  excerpt: (row) => row.body.slice(0, 100),
})
```

Virtuals are automatically applied to results from `findMany` / `findOne` / `findById`. They are also applied to `insertOne` / `insertMany` results.

---

## Traits

### v2

```ts
import { createTrait, timestamps, softDelete, paranoid } from '@kaynooo/pg-orm'

// Custom trait
const publishable = createTrait()
  .fields(f => ({
    publishedAt: f.timestamp().nullable().toConfig(),
  }))
  .method('publish', async function (repo) {
    await repo.update(this.id, { publishedAt: new Date() })
  })
  .build()

const Entity = orm.entity('posts', f => ({...}))
  .useTrait(timestamps())
  .useTrait(softDelete())
  .useTrait(publishable)
  .build()
```

### v3

```ts
import { defineTable, timestamps, softDelete, optimisticLock } from '@kaynooo/pg-orm'
import type { Trait } from '@kaynooo/pg-orm'

// Custom trait
const publishable: Trait = {
  columns: t => ({
    publishedAt: t.timestamptz().nullable(),
  }),
  virtuals: {
    isPublished: (row) => row.publishedAt != null,
  },
  // hooks are registered via a function that receives the table:
  hooks: (table) => {
    table.hook('beforeUpdate', (data) => {
      // ...
    })
  },
}

const posts = defineTable('posts', t => ({...}))
  .withTrait(timestamps())
  .withTrait(softDelete())        // was paranoid() in v2
  .withTrait(optimisticLock())    // was versionable() in v2
  .withTrait(publishable)
```

### Built-in trait mapping

| v2 trait | v3 equivalent |
|---|---|
| `timestamps()` | `timestamps({ createdAt?, updatedAt? })` |
| `softDelete()` | part of `softDelete(column?)` — adds `deletedAt` |
| `paranoid()` | `timestamps()` + `softDelete()` (apply both) |
| `versionable()` | `optimisticLock(column?)` |
| `uuidPrimary()` | define `id: t.uuid().primaryKey().default('gen_random_uuid()')` manually |
| `sluggable()` | **removed** — implement as a custom `Trait` |
| `publishable()` | **removed** — implement as a custom `Trait` |
| `sortable()` | **removed** — implement as a custom `Trait` |

### Soft delete usage change

```ts
// v2 — methods were on the entity instance
await entity.softDelete(repo)
await entity.restore(repo)
entity.isDeleted()

// v3 — methods are on the repository
await repo.deleteMany(e => e.eq('id', entity.id))  // triggers soft delete automatically
await repo.restore(e => e.eq('id', entity.id))
await repo.forceDelete(e => e.eq('id', entity.id))

// Include soft-deleted rows
const all = await repo.findMany(q => q.withTrashed())

// isDeleted is a virtual
entity.isDeleted // true | false
```

### Optimistic lock usage change

```ts
// v2 — versionable trait, version field, manual retry
const entity = await repo.find(1)
await repo.update(entity.id, { name: 'new', version: entity.version })

// v3 — updateWithLock throws StaleRecordError automatically
const entity = await repo.findById(1)
await repo.updateWithLock({ name: 'new' }, entity) // passes entity to carry version
```

---

## Hooks

### v2

```ts
const Entity = orm.entity('users', f => ({...}))
  .beforeCreate(async (data) => {
    data.email = data.email.toLowerCase()
  })
  .afterCreate(async (entity) => {
    await sendWelcomeEmail(entity.email)
  })
  .build()
```

### v3

Hooks are registered directly on the `TableDef` via `.hook(event, handler)`:

```ts
const users = defineTable('users', t => ({...}))

users.hook('beforeInsert', async (data) => {
  data.email = (data.email as string).toLowerCase()
})

users.hook('afterInsert', async (rows) => {
  for (const row of rows) await sendWelcomeEmail(row.email as string)
})
```

### Hook event mapping

| v2 | v3 |
|---|---|
| `beforeCreate` | `beforeInsert` |
| `afterCreate` | `afterInsert` |
| `beforeUpdate` | `beforeUpdate` |
| `afterUpdate` | `afterUpdate` |
| `beforeDelete` | `beforeDelete` |
| `afterDelete` | `afterDelete` |

---

## Transactions

### v2

```ts
// Transaction bound to a single repository
const result = await repo.transaction(async (txRepo) => {
  const user = await txRepo.create({ name: 'Alice' })
  await txRepo.update(user.id, { verified: true })
  return user
})
```

### v3

Transactions span multiple repositories. Pass the `TransactionClient` to each repo via `.using(tx)`:

```ts
const result = await db.transaction(async (tx) => {
  const userRepo = db.repo(users).using(tx)
  const postRepo = db.repo(posts).using(tx)

  const user = await userRepo.insertOne({ name: 'Alice', email: 'a@x.com' })
  await postRepo.insertOne({ authorId: user.id, title: 'Hello' })
  return user
})

// With isolation level
await db.transaction({ isolation: 'serializable' }, async (tx) => {
  // ...
})

// After-commit callbacks
await db.transaction(async (tx) => {
  tx.onAfterCommit(() => console.log('committed!'))
  tx.onAfterRollback(() => console.log('rolled back!'))
  // ...
})

// Savepoints
await db.transaction(async (tx) => {
  await tx.savepoint(async (sp) => {
    // throw SavepointRollback or call sp.rollback() to roll back savepoint only
  })
})
```

---

## Migrations

### v2

Migrations were configured through `ORM.connect()` and run automatically or via CLI.

```ts
await orm.connect({
  connectionString: '...',
  migrations: {
    directory: './migrations',
    autoMigrate: true,
    tableName: '_migrations',
  },
})
```

### v3

Migrations are explicit. Register your tables, then call `db.sync()`:

```ts
const db = new Database({
  url: '...',
  tables: [users, posts, comments],
})

// Generate and apply a migration (single transaction)
const { sql, ops } = await db.sync({ dryRun: true })        // preview
const { sql, ops } = await db.sync()                         // apply
const { sql, ops } = await db.sync({ allowDestructive: true }) // allow DROP

// Roll back last N migrations
const { rolledBack, sql } = await db.rollback(1)
```

You can also use the lower-level functions directly:

```ts
import {
  introspectLiveSchema,
  diffSchema,
  generateMigration,
  applyMigration,
  getMigrationHistory,
  getMigrationStatus,
  ensureMigrationTable,
  recordMigration,
} from '@kaynooo/pg-orm'
```

---

## Error handling

### v2 error classes

```ts
import {
  EntityNotFoundError,
  OptimisticLockError,
  QueryError,
  DatabaseError,
  UniqueConstraintViolationError,
  ForeignKeyConstraintViolationError,
  NotNullConstraintViolationError,
  BulkOperationError,
  ValidationError,
} from '@kaynooo/pg-orm'
```

### v3 error hierarchy

```
OrmError
├── QueryError
│   ├── ConstraintError
│   │   ├── UniqueError
│   │   ├── ForeignKeyError
│   │   ├── NotNullError
│   │   └── CheckError
│   └── DeadlockError
├── ConnectionError
├── TimeoutError
├── MigrationError
│   └── DestructiveOpError
├── AfterHookError
├── NotFoundError
└── StaleRecordError
```

```ts
import {
  OrmError,
  QueryError,
  UniqueError,
  ForeignKeyError,
  NotNullError,
  CheckError,
  DeadlockError,
  ConnectionError,
  TimeoutError,
  NotFoundError,
  StaleRecordError,
  MigrationError,
  DestructiveOpError,
  AfterHookError,
} from '@kaynooo/pg-orm'
```

### Migration example

```ts
// v2
try {
  await repo.create(data)
} catch (err) {
  if (err instanceof UniqueConstraintViolationError) { /* ... */ }
  if (err instanceof EntityNotFoundError) { /* ... */ }
  if (err instanceof OptimisticLockError) { /* ... */ }
}

// v3
try {
  await repo.insertOne(data)
} catch (err) {
  if (err instanceof UniqueError) { /* ... */ }
  if (err instanceof NotFoundError) { /* ... */ }
  if (err instanceof StaleRecordError) { /* ... */ }
}
```

---

## Removed features

The following v2 features have **no v3 equivalent** and must be replaced manually:

| Feature | Action required |
|---|---|
| **Cache adapter** (`InMemoryCache`, `CacheAdapter`) | Implement application-level caching. v3 does not cache query results. |
| **`SeederRunner` / `defineFactory`** | Implement your own seeders. Consider a library like `@snaplet/seed`. |
| **`sanitizeError()`** | Removed. Catch `OrmError` subclasses directly. |
| **`ValidationError`** | No client-side value validation in v3. Rely on DB constraints and application-level validation. |
| **`queryLogger` singleton** | Use `onQuery` / `onSlowQuery` callbacks on `DbConfig`. |
| **Scopes** (`EntityBuilder.scope(name, fn)`) | Extract query builder callbacks into plain functions. |
| **`sluggable()`, `sortable()`, `publishable()`, `uuidPrimary()` traits** | Implement as custom `Trait` objects. |
| **`ValidationError` / field validators** | Removed. Use DB constraints (`check()`, `notNull()`, `unique()`) or validate before calling the ORM. |
| **`orm.clearEntities()`** | Not needed — each `Database` instance is independent. |
| **`sql` tagged template / `SQL` export from db** | Use `db.raw(sql, params)` for raw queries. |
| **`transaction` on a single repo** | Use `db.transaction(async tx => { repo.using(tx) })`. |
| **`getDatabase()` / `initializeDatabase()` globals** | Create and export `const db = new Database(config)` instead. |
