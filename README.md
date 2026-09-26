# @kaynooo/pg-orm

Lightweight, type-safe PostgreSQL ORM built on [`bun:sql`](https://bun.sh/docs/api/sql). Zero-overhead phantom types, JIT-compiled row mappers, and a tape-based expression compiler.

## Features

- **Type-safe schema** — `defineTable()` with full TypeScript inference for selects, inserts, and updates
- **Query builder** — chainable, immutable-style API with parameterized queries (no SQL injection)
- **Expression builder** — type-safe WHERE clauses, JOINs, CTEs, window functions, JSONB, full-text search, pgvector
- **Relation loading** — batched `include()` (no N+1), supports `belongsTo`, `hasMany`, `hasOne`, `hasManyThrough`
- **Auto-migration** — `db.sync()` introspects your live DB and applies DDL diffs
- **Traits** — composable behaviors: `softDelete()`, `timestamps()`, `optimisticLock()`
- **JIT mappers** — compiled at schema-definition time for fast row-to-object mapping
- **Hooks** — `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`, `afterSelect`
- **Transactions** — full support with savepoints, isolation levels, and statement timeouts
- **Streaming** — async iterator with chunked fetching
- **Minimal dependencies** — 1 runtime dependency (`@kaynooo/utils`)

## Install

```bash
bun add @kaynooo/pg-orm
```

Requires [Bun](https://bun.sh) with `bun:sql` support.

## Quick Start

```ts
import { Database, defineTable, timestamps, softDelete } from '@kaynooo/pg-orm'

// 1. Define tables
const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  email: t.varchar(255).notNull().unique(),
  role: t.text().notNull().default('user'),
}))
  .withTrait(softDelete())
  .withTrait(timestamps())

const posts = defineTable('posts', t => ({
  id: t.serial().primaryKey(),
  title: t.text().notNull(),
  body: t.text().notNull(),
  authorId: t.integer().notNull(),
}))
  .withTrait(timestamps())

// 2. Wire relations (after all tables are defined)
users.withRelations(r => ({
  posts: r.hasMany('posts', 'authorId'),
}))

posts.withRelations(r => ({
  author: r.belongsTo('users', 'authorId'),
}))

// 3. Connect
const db = new Database({
  url: 'postgres://user:pass@localhost:5432/mydb',
  tables: [users, posts],
})

// 4. Auto-migrate
await db.sync()

// 5. CRUD — operations live on the `read`, `write` and `stream` suites.
// `db.repo()` is memoized per table, so calling it inline costs nothing.
const UserRepo = db.repo(users)
const PostRepo = db.repo(posts)

// Write ops return the primary key by default; pass `{ full: true }` for the full row.
const aliceId = await UserRepo.write.insertOne({ name: 'Alice', email: 'alice@example.com' })

const allUsers = await UserRepo.read.findMany()

const filtered = await PostRepo.read.findMany(q =>
  q.where({ authorId: aliceId })
   .orderBy('id', 'desc')
   .limit(10),
)

await UserRepo.write.updateById(aliceId, { name: 'Alice Updated' })

await UserRepo.write.deleteById(aliceId)
```

## Schema Definition

```ts
import { defineTable } from '@kaynooo/pg-orm'

const items = defineTable('items', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull().unique(),
  price: t.numeric(10, 2).notNull(),
  tags: t.array(t.text()).nullable(),
  status: t.enum('item_status', ['active', 'archived'] as const).notNull(),
  metadata: t.jsonb().nullable(),
  embedding: t.vector(1536).nullable(),
  score: t.int4().check('score >= 0'),
}))
```

### Column Types

`serial`, `bigserial`, `int2`, `int4`, `int8`, `smallint`, `integer`, `bigint`, `float4`, `float8`, `real`, `doublePrecision`, `numeric`, `text`, `varchar`, `char`, `citext`, `boolean`, `bool`, `date`, `timestamp`, `timestamptz`, `time`, `timetz`, `interval`, `uuid`, `json`, `jsonb`, `bytea`, `inet`, `cidr`, `macaddr`, `point`, `line`, `circle`, `box`, `path`, `polygon`, `tsvector`, `tsquery`, `xml`, `money`, `bit`, `varbit`, `vector`, `enum`, `array`

`smallint`/`integer`/`bigint`/`real`/`doublePrecision`/`boolean` are SQL-standard aliases for `int2`/`int4`/`int8`/`float4`/`float8`/`bool` — pick one spelling per project. Arrays are `t.array(t.text())`; `numeric` and `money` infer `string` to keep full precision, `int8`/`bigserial` infer `bigint`.

### Constraints

```ts
t.text().notNull()        // NOT NULL
t.text().nullable()       // explicit nullable
t.text().unique()         // UNIQUE constraint
t.text().primaryKey()     // PRIMARY KEY
t.text().default('val')   // DEFAULT, from a JS value
t.timestamptz().defaultRaw('now()') // DEFAULT, from raw SQL
t.int4().check('val > 0') // CHECK constraint
t.int4().generated('col1 + col2') // GENERATED ALWAYS AS ... STORED
```

> **No case conversion.** Column keys are used as PostgreSQL identifiers *verbatim* —
> there is no automatic `camelCase` ↔ `snake_case` mapping. A key named `authorId`
> becomes a quoted `"authorId"` column, not `author_id`. If you want snake_case
> columns, name the keys in snake_case yourself. (Keys are validated against
> `/^[a-zA-Z_][a-zA-Z0-9_]*$/`, never rewritten.)

## Relations

Pass the target table behind a thunk: the included rows are typed from it, `hasMany`/`hasOne` check the foreign key against its columns, and the thunk survives circular imports. Declare each table's columns first and wire relations in a second statement pointing at the other tables' column-only definitions, so two tables referencing each other do not make TypeScript infer a circular type.

```ts
// users.ts
export const UsersBase = defineTable('users', t => ({ id: t.serial().primaryKey(), name: t.text() }))
export const Users = UsersBase.withRelations(r => ({
  posts:    r.hasMany(() => PostsBase, 'authorId'),
  profile:  r.hasOne(() => Profiles, 'userId'),
}))

// posts.ts
export const PostsBase = defineTable('posts', t => ({ id: t.serial().primaryKey(), authorId: t.int4() }))
export const Posts = PostsBase.withRelations(r => ({
  author:   r.belongsTo(() => UsersBase, 'authorId'),
  tags:     r.hasManyThrough(() => Tags, () => PostTags, { from: 'postId', to: 'tagId' }),
}))
```

The target can also be named, with its row type as a type argument: `r.hasMany<InferEntity<typeof PostsBase>>('posts', 'authorId')`. Every table a relation reaches must be registered in `new Database({ tables })`.

### Eager Loading (No N+1)

```ts
// Load relations in batched queries
const usersWithPosts = await UserRepo.read.findMany(q => q.include('posts'))
// usersWithPosts[0].posts is typed as Post[]

// Nested includes
const postsWithAll = await PostRepo.read.findMany(q =>
  q.include('author').include('comments'),
)

// Relation filtering
const usersWithPublished = await UserRepo.read.findMany(q =>
  q.include('posts', sq => sq.where({ published: true })),
)
```

## Query Builder

### WHERE Expressions

Every WHERE takes one of two forms: an **object shorthand** for the common case, or an
`ExprBuilder` **callback** for anything the shorthand can't express (`OR`, subqueries,
raw fragments). Both are fully typed against the table's columns and both parameterize
their values. The two mix freely.

```ts
// Object shorthand — every entry ANDed
q.where({ status: 'active' })
q.where({ status: 'active', role: 'admin' })
q.where({ deletedAt: null })          // IS NULL
q.where({ role: ['admin', 'mod'] })   // IN (…), and an empty array matches nothing
q.where({ prefs: { theme: 'dark' } }) // a json/jsonb value, compared for equality

// ...with operators, several of which AND together
q.where({ age: { gte: 18, lt: 65 } })
q.where({ name: { contains: 'dev' } })       // ILIKE '%dev%', metacharacters escaped
q.where({ price: { between: [10, 100] } })
q.where({ deletedAt: { isNull: false } })
q.where({ tags: { eq: ['a', 'b'] } })        // an array column takes no bare array
```

Operators: `eq neq gt gte lt lte in notIn like ilike contains startsWith endsWith between isNull`.

`undefined` as a value and `{}` as a whole clause both throw `ValidationError` — a typo
must not silently widen a `deleteMany` to every row.

```ts
// Callback form — the full expression builder
q.where(e => e.and(
  e.eq('status', 'active'),
  e.or(e.gt('age', 18), e.eq('role', 'admin')),
))

// Optional conditions — a falsy clause is skipped, so query-string filters
// need no branching. `andWhere` also works as the first clause.
q.andWhere(status && { status })
 .andWhere(minAge !== undefined && { age: { gte: minAge } })

// ...or pass them all at once (falsy entries dropped, rest ANDed)
q.whereAll(
  search && { name: { contains: search } },
  onlyActive && { status: 'active' },
)

// Pattern matching (auto-escapes user input)
q.where(e => e.startsWith('name', 'Al'))  // ILIKE 'Al%'
q.where(e => e.contains('bio', 'dev'))     // ILIKE '%dev%'

// Null checks
q.where(e => e.isNull('deletedAt'))

// JSONB
q.where(e => e.jsonbPath('metadata', '$.tags[*] ? (@ == "important")'))

// Full-text search
q.where(e => e.tsMatch('searchVector', e.tsQuery('english', 'hello world')))

// pgvector
q.orderBy('embedding', 'asc') // with vectorCosineDistance in computed
```

### JOINs, CTEs, Window Functions

```ts
// JOIN
q.join('orders', 'o', e => e.raw('"o"."userId" = "users"."id"'))
q.leftJoin('profiles', 'p', e => e.raw('"p"."userId" = "users"."id"'))

// CTE
q.with('active_users', 'SELECT * FROM users WHERE active = true')
q.withRecursive('tree', 'SELECT ... UNION ALL SELECT ...')

// Window
q.window('w', { partitionBy: ['department'], orderBy: [{ col: 'salary', dir: 'desc' }] })
  .computedRaw(rawExpr<number>('ROW_NUMBER() OVER w'), 'rank') // rows get a typed `rank: number`

// Aggregates
q.aggregate(e => ({
  total: e.countCol(),
  maxPrice: e.max('price'),
  avgScore: e.avg('score'),
}))

// GROUP BY + HAVING — takes both WHERE forms
q.groupBy('department').having(e => e.gt('count', 5))
```

### Repository operation suites

Repository operations are grouped into three suites accessed as properties:

- `repo.read` — `findMany`, `findOne`, `findOneOrThrow`, `findManyBy`, `findOneBy`, `findById`, `findByIdOrThrow`, `existsById`, `count`, `exists`, `paginate`, `paginateCursor`, `select()`
- `repo.write` — `insertOne/Many`, `updateOne/Many/ById`, `updateWithLock`, `deleteOne/Many/ById`, `upsertOne/Many`, `findOrCreate`, `restore`, `forceDelete`, plus `insert/update/delete/merge/upsert` builders. These return the primary key by default; pass `{ full: true }` for the full row(s)
- `repo.stream` — `stream` (LIMIT/OFFSET) and `streamCursor` (keyset)

`db.repo(table)` is memoized per table definition, so calling it inline (`db.repo(users).read.findMany()`) on every request is free - no need to hoist repositories into module-level constants or wrap them in your own cache. The cache is keyed weakly on the table def and invalidated automatically when the def is mutated (`withRelations`, `withVirtuals`, `withTrait`, `hook`). `repo.using(tx)` is memoized per transaction client, so rebinding inside a loop is free too.

### Reads

```ts
await repo.read.findMany(q => q.where({ status: 'active' }).pick('id', 'name').limit(10))
await repo.read.count({ status: 'active' })
await repo.read.exists({ email: 'a@test.com' })

// Nothing but a WHERE — the shape count/exists/deleteMany already take
await repo.read.findManyBy({ status: 'active' })
await repo.read.findOneBy({ email: 'a@test.com' })

// By primary key — a composite key takes an object holding each part
await repo.read.findById(1)
await repo.read.findById(1, q => q.pick('id', 'name').include('posts'))
await repo.read.findByIdOrThrow(1)      // throws NotFoundError instead of returning null
await repo.read.existsById(1)
await repo.read.findById({ userId: 1, groupId: 2 })

// Soft-delete tables: count/exists/paginate skip trashed rows unless asked
await repo.read.count({ status: 'active' }, { withTrashed: true })
```

### Mutations

By default, write operations return the **primary key** (a single id, or an array of
ids for the `*Many` variants — `null` for the `*One` variants when nothing matched).
A composite key comes back as an object holding each part, the shape the by-id ops take.
Pass `{ full: true }` as the final argument to get the full row(s) back, with virtuals
applied. Returning only the key keeps the common case cheap: `RETURNING "id"` instead of
`RETURNING *`.

```ts
// Insert — returns the primary key
const id = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
const ids = await repo.write.insertMany([{ ... }, { ... }])

// ...or the full entity with `{ full: true }`
const alice = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { full: true })

// Update — the where takes both forms, and `updateById` spells out the common one
await repo.write.updateMany({ status: 'active' }, { role: 'admin' })
const updated = await repo.write.updateOne({ name: 'Bob' }, { id: 1 }, { full: true })
await repo.write.updateById(1, { name: 'Bob' })

// One statement, a different value per row (reorders, tallies, sync diffs). Rows may write different columns.
await repo.write.updateManyById([{ id: 1, position: 0 }, { id: 2, position: 1, title: 'Renamed' }])

// Delete
await repo.write.deleteById(1)
await repo.write.deleteMany({ createdAt: { lt: cutoff } })

// Upsert — INSERT ... ON CONFLICT (conflictTarget) DO UPDATE
await repo.write.upsertOne({ key: 'theme', value: 'dark' }, ['key'])
await repo.write.upsertMany([{ ... }, { ... }], ['key'])

// ...restricting which columns the conflicting row gets updated with
await repo.write.upsertOne({ key: 'theme', value: 'dark', createdBy: 1 }, ['key'], ['value'])

// Insert if missing, return the existing row otherwise — never overwrites
await repo.write.findOrCreate({ email: 'a@test.com', name: 'Alice' }, ['email'])
const alice = await repo.write.findOrCreate({ email: 'a@test.com', name: 'Alice' }, ['email'], { full: true })
```

`conflictTarget` must be covered by a unique index (a unique column, or a composite
unique index declared via `withIndexes`), otherwise PostgreSQL rejects the statement.

## Traits

```ts
import { defineTable, softDelete, timestamps, optimisticLock } from '@kaynooo/pg-orm'

const users = defineTable('users', t => ({ ... }))
  .withTrait(softDelete('deletedAt'))  // adds deletedAt column + isDeleted virtual
  .withTrait(timestamps())              // adds createdAt, updatedAt + auto-update hook
  .withTrait(optimisticLock())          // adds version column + auto-increment

// Soft-delete: deleteMany/deleteOne sets deletedAt instead of DELETE
// Use .withTrashed() to include soft-deleted rows
// Use .forceDelete() for real DELETE

// Optimistic lock: updateWithLock() checks version, throws StaleRecordError on conflict
await repo.write.updateWithLock({ name: 'Updated' }, { id: 1 }, currentVersion)
```

### Schema introspection

Table and column metadata, typed — for generic code that derives request schemas, admin
UIs or CRUD routes from a table definition instead of restating its shape.

```ts
import { columnBaseType, hasTrait, tableMeta, traitColumns, writableColumns } from '@kaynooo/pg-orm'

tableMeta(users).softDelete?.column   // 'deletedAt' — same for optimisticLock / timestamps
hasTrait(users, 'softDelete')         // true; works for custom traits by their `name`

traitColumns(users)                   // every column any trait added, custom traits included
writableColumns(users)                // all columns except the pk, generated and trait-managed ones
writableColumns(users, { exclude: ['ownerId'] })

columnBaseType(users.columns.tags)    // { base: 'text', isArray: true } — from 'text[]'
columnBaseType(users.columns.email)   // { base: 'varchar', isArray: false } — from 'varchar(255)'
```

## Hooks

```ts
users.hook('beforeInsert', (row) => ({
  ...row,
  email: row.email.toLowerCase(),
}))

users.hook('afterSelect', (rows) => {
  // transform rows after fetch
  return rows
})
```

Available hooks: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`, `afterSelect`, `beforeUpsert`

## Transactions

```ts
await db.transaction(async (tx) => {
  const txRepo = UserRepo.using(tx)
  await txRepo.write.insertOne({ name: 'Alice', email: 'a@test.com' })

  // Savepoints
  try {
    await tx.savepoint(async (sp) => {
      await txRepo.write.insertOne({ name: 'Dupe', email: 'a@test.com' })
    })
  } catch {
    // savepoint rolled back, outer tx continues
  }
})

// With isolation level
await db.transaction(
  { isolation: 'serializable', accessMode: 'read write' },
  async (tx) => { ... },
)
```

## Pagination

```ts
// Offset-based
const page = await repo.read.paginate({ page: 1, perPage: 20 })
// { data, total, page, perPage, totalPages }

// The optional callback shapes the page. A filter it adds is reflected in `total`,
// so `data` and `total` always describe the same row set.
const shaped = await repo.read.paginate(
  { page: 1, perPage: 20, where: { status: 'active' } },
  q => q.pick('id', 'name').orderBy('createdAt', 'desc').include('posts'),
)

// Cursor-based (efficient for large datasets)
const page1 = await repo.read.paginateCursor({ take: 20, column: 'id' })
const page2 = await repo.read.paginateCursor({
  take: 20,
  column: 'id', cursor: page1.nextCursor,
})
```

## Streaming

```ts
for await (const row of repo.stream.stream(q => q.where({ active: true }), { chunkSize: 500 })) {
  // process row
}

// Cursor-based (safe for mutable data):
for await (const row of repo.stream.streamCursor({ chunkSize: 500 })) {
  // process row
}
```

> **Note**: `stream()` uses LIMIT/OFFSET chunking internally. If rows are inserted or deleted during iteration, rows may be skipped or duplicated. For correctness on mutable data during long-running streams, use `streamCursor()` instead, or run inside a `REPEATABLE READ` transaction.

## Migration

```ts
// Auto-sync: introspect DB + apply diff
const { sql, ops } = await db.sync({ dryRun: true })  // preview changes
await db.sync()                                         // apply changes
await db.sync({ allowDestructive: true })               // allow DROP TABLE/COLUMN

// Check drift
const { hasDrift, drift } = await getMigrationStatus(db, db.getTablesRegistry())

// Generate migration file
const migration = await generateMigration(db, db.getTablesRegistry())
// { name, up, down }
```

### Foreign keys

Foreign key constraints are emitted as separate `add_fk` operations *after* all
`create_table` operations, so a FK-violating declaration order is safe on an empty
database. They are also diffed for existing tables: adding `.references()` to a
column generates `ALTER TABLE ... ADD CONSTRAINT` on the next `sync()`, removing it
generates a (destructive) `DROP CONSTRAINT`, and changing the target/`onDelete`/
`onUpdate` is detected as a change.

## Raw SQL

```ts
// Tagged template (parameterized)
const rows = await db.raw<{ count: string }>`SELECT count(*) FROM users WHERE age > ${18}`

// String + params
const rows = await db.raw('SELECT * FROM users WHERE id = $1', [1])
```

## Error Handling

All errors extend `OrmError`. The ORM maps PostgreSQL error codes to typed errors:

| Error Class | PG Code | Description |
|-------------|---------|-------------|
| `UniqueError` | 23505 | Unique constraint violation |
| `ForeignKeyError` | 23503 | Foreign key violation |
| `NotNullError` | 23502 | NOT NULL violation |
| `CheckError` | 23514 | CHECK constraint violation |
| `ConnectionError` | 08xxx, 57P01 | Connection / server shutdown |
| `TimeoutError` | 57014 | Statement timeout |
| `StaleRecordError` | — | Optimistic lock version mismatch |
| `DestructiveOpError` | — | Blocked destructive migration |

```ts
import { UniqueError, StaleRecordError } from '@kaynooo/pg-orm'

try {
  await repo.write.insertOne({ email: 'duplicate@test.com', name: 'Test' })
} catch (err) {
  if (err instanceof UniqueError) {
    console.log(`Duplicate on column: ${err.column}`)
  }
}
```

`QueryError` redaction is **safe-by-default**: with no `redactParams` configured, the
positional params on a `QueryError` are replaced with `'[REDACTED]'` placeholders so
values never leak into shared logs. The mode is resolved per error:

- `NODE_ENV=production` **or** `REDACT_QUERY_LOGS=1` — hard-redact: `query` becomes `'[REDACTED]'` and `params` becomes `[]`.
- `REDACT_QUERY_LOGS=0` — opt out entirely: raw SQL and params are preserved verbatim (use for local debugging only).
- Otherwise — apply the configured `redactParams` if set, else the safe default that scrubs every param.

A `redactParams` redactor **must not throw** — a throwing redactor propagates out of the
`QueryError` constructor by design, so the bug surfaces loudly instead of silently
producing empty params.

The `onQuery` / `onSlowQuery` / `onError` events follow the same rules for `params`, except that with no `redactParams` they carry the raw values outside hard-redact mode, so a local debug hook can still render them.

## Configuration

```ts
const db = new Database({
  // Connection (pick one)
  url: 'postgres://user:pass@host:5432/db',
  // or individual fields:
  hostname: 'localhost',
  port: 5432,
  database: 'mydb',
  username: 'user',
  password: 'pass',

  // Pool
  pool: {
    max: 10,
    idleTimeout: 30000,
    maxLifetime: 600000,
    connectionTimeout: 5000,
  },

  // TLS
  tls: true,

  // Tables (for auto-migration and relation registry)
  tables: [users, posts],

  // Schema (default: 'public')
  schema: 'public',

  // Statement timeout (ms)
  statementTimeout: 30000,

  // idle_in_transaction_session_timeout (ms) — kills connections that hold a
  // transaction open without activity. The prod safety net for forgotten awaits.
  idleInTransactionTimeout: 60000,

  // Reported as application_name on the PG connection — shows up in pg_stat_activity
  // and PG logs for filtering and incident attribution.
  application_name: 'my-service',

  // Debug logging — prints every query with its $n placeholders filled in.
  // `true` logs to the console; pass a function to route lines elsewhere.
  // Ignored under NODE_ENV=production / REDACT_QUERY_LOGS=1.
  debug: process.env.DB_DEBUG === '1',

  // Query logging
  onQuery: (event) => console.log(event.sql, event.durationMs),
  onSlowQuery: (event) => console.warn(`Slow query: ${event.durationMs}ms`),
  slowQueryThreshold: 1000,

  // Called when transaction onCommit/onRollback callbacks throw, or when a
  // stream safety warning surfaces. Without this, those errors are silently
  // swallowed (the tx already settled, so re-throwing would lie about state).
  onCallbackError: ({ kind, error }) => log.error(`pg-orm ${kind} failed`, error),
})

// Health check
const ok = await db.ping()

// Format a QueryEvent yourself — same renderer the `debug` flag uses
import { formatQuery } from '@kaynooo/pg-orm'

formatQuery(event) // [0.412ms] SELECT * FROM "users" WHERE "email" = 'alice@example.com'
formatQuery(event, { colors: true, duration: false, maxParamLength: 40 })

// Graceful close — drain: wait for in-flight queries before closing the pool.
await db.close({ drain: true, timeout: 5000 })
```

## Production Checklist

Copy-pasteable config for production workloads. Every option below is documented
above; this section is the recommended *combination*. Each rail addresses a
distinct failure mode that's expensive to debug after the fact.

```ts
const db = new Database({
  url: process.env.DATABASE_URL!,
  tables: [users, posts /* … */],

  // Pool — size to peak concurrent in-flight queries; oversizing wastes server
  // connections and starves other clients.
  pool: { max: 20, idleTimeout: 30_000, connectionTimeout: 5_000 },

  // Server-side safety net for runaway queries (kills statements after N ms).
  statementTimeout: 30_000,

  // Server-side safety net for forgotten `await`s inside transaction callbacks
  // — PG will end the connection if the tx idles past this. Pairs with the
  // app-side AbortSignal you should plumb into long-running tx bodies.
  idleInTransactionTimeout: 60_000,

  // Cheap incident-triage win: every connection labels itself in pg_stat_activity
  // and PG logs. Include version/instance for easy filtering.
  application_name: `my-service@${process.env.GIT_SHA ?? 'dev'}`,

  // Cap unbounded SELECTs that omit `.limit()`. Catches "forgot to paginate" bugs
  // before they hit production.
  defaultLimit: 1000,

  // Auto-retry transient connection errors (admin shutdowns, connection drops).
  // Does NOT retry inside a transaction — those bubble up.
  retry: { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5_000 },

  // Observability — every query, slow query, and error has a hook. Combine with
  // `db.withContext({ requestId, traceId }, fn)` to correlate query logs to
  // incoming requests.
  onQuery: (e) => metrics.histogram('pg.query.duration', e.durationMs, e.context),
  onSlowQuery: (e) => log.warn({ sql: e.sql, ms: e.durationMs, ...e.context }, 'slow query'),
  onError: (e) => log.error({ sql: e.sql, err: e.error, ...e.context }, 'query failed'),
  slowQueryThreshold: 500,

  // Don't drop tx callback failures on the floor — by the time they fire the tx
  // is already committed/rolled-back, so re-throwing would change observed state.
  onCallbackError: ({ kind, error }) => log.error({ kind, err: error }, 'pg-orm callback failed'),

  // Strip secrets from QueryError.params before they reach your logger.
  redactParams: (params) => params.map(p => typeof p === 'string' && p.length > 64 ? '[redacted]' : p),
})

// Request-scoped correlation — wraps a request handler so every query inside
// (including in nested transactions) tags its QueryEvent with the request id.
app.use((req, _res, next) => db.withContext({ requestId: req.id }, () => next()))

// On shutdown — drain in-flight queries, then close the pool. Without `drain`,
// in-flight queries are aborted when the pool closes.
process.on('SIGTERM', async () => {
  await db.close({ drain: true, timeout: 10_000 })
})
```

## Security model

This library is type-safe and parameterizes every column-value, expression-leaf,
and tagged-template interpolation it generates. SQL injection is structurally
impossible through the typed APIs.

A small surface of **escape hatches** accepts raw SQL strings that are embedded
unparameterized — pass only developer-authored SQL through these, never user
input. They are explicitly marked `@trusted` in JSDoc:

| API | Where the string lands |
| --- | --- |
| `t.text().check(expr)` | `CHECK (expr)` in DDL |
| `t.int().generated(expr)` | `GENERATED ALWAYS AS (expr) STORED` in DDL |
| `t.text().defaultRaw(sql)` | `DEFAULT sql` in DDL |
| `t.text().index({ where })` | `WHERE` clause of a partial index. Validated at `defineTable()` to reject `;` / `--` / `/*` outside string literals. |
| `q.computedRaw(expr, alias)`, `rawExpr(sql)` | SELECT-list expression |
| `e.raw(sql, ...params)` | WHERE/ON fragment (positional `?` params are bound; the surrounding SQL is verbatim) |
| `db.raw(sql, params)` / tagged template | full query body |

Validation errors (invalid identifiers, non-finite numbers, unsafe delimiters,
injection-shaped raw fragments) throw `ValidationError extends OrmError`.

## License

MIT
