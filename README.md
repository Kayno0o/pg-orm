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
  role: t.text().notNull().default("'user'"),
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

// 5. CRUD
const UserRepo = db.repo(users)
const PostRepo = db.repo(posts)

const alice = await UserRepo.insertOne({ name: 'Alice', email: 'alice@example.com' })

const allUsers = await UserRepo.findMany()

const filtered = await PostRepo.findMany(q =>
  q.where(e => e.eq('authorId', alice.id))
   .orderBy('id', 'desc')
   .limit(10),
)

await UserRepo.updateMany({ name: 'Alice Updated' }, e => e.eq('id', alice.id))

await UserRepo.deleteOne(e => e.eq('id', alice.id))
```

## Schema Definition

```ts
import { defineTable } from '@kaynooo/pg-orm'

const items = defineTable('items', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull().unique(),
  price: t.numeric(10, 2).notNull(),
  tags: t.textArray().nullable(),
  status: t.enum('item_status', ['active', 'archived'] as const).notNull(),
  metadata: t.jsonb().nullable(),
  embedding: t.vector(1536).nullable(),
  score: t.int4().check('score >= 0'),
}))
```

### Column Types

`serial`, `bigserial`, `integer`, `int4`, `int8`, `smallint`, `real`, `doublePrecision`, `numeric`, `text`, `varchar`, `char`, `boolean`, `bool`, `date`, `timestamp`, `timestamptz`, `time`, `timetz`, `uuid`, `jsonb`, `json`, `bytea`, `inet`, `cidr`, `macaddr`, `interval`, `point`, `line`, `circle`, `box`, `path`, `polygon`, `tsvector`, `tsquery`, `xml`, `money`, `bit`, `varbit`, `textArray`, `intArray`, `vector`, `enum`

### Constraints

```ts
t.text().notNull()        // NOT NULL
t.text().nullable()       // explicit nullable
t.text().unique()         // UNIQUE constraint
t.text().primaryKey()     // PRIMARY KEY
t.text().default("'val'") // DEFAULT (raw SQL expression)
t.int4().check('val > 0') // CHECK constraint
t.int4().generated('col1 + col2') // GENERATED ALWAYS AS ... STORED
```

## Relations

```ts
// After all tables are defined:
users.withRelations(r => ({
  posts:    r.hasMany('posts', 'authorId'),
  profile:  r.hasOne('profiles', 'userId'),
}))

posts.withRelations(r => ({
  author:   r.belongsTo('users', 'authorId'),
  tags:     r.hasManyThrough('tags', 'post_tags', { from: 'postId', to: 'tagId' }),
}))
```

### Eager Loading (No N+1)

```ts
// Load relations in batched queries
const usersWithPosts = await UserRepo.findMany(q => q.include('posts'))
// usersWithPosts[0].posts is typed as Post[]

// Nested includes
const postsWithAll = await PostRepo.findMany(q =>
  q.include('author').include('comments'),
)

// Relation filtering
const usersWithPublished = await UserRepo.findMany(q =>
  q.include('posts', sq => sq.where(e => e.eq('published', true))),
)
```

## Query Builder

### WHERE Expressions

```ts
// Comparison
q.where(e => e.eq('status', 'active'))
q.where(e => e.gt('age', 18))
q.where(e => e.between('price', 10, 100))
q.where(e => e.in('role', ['admin', 'mod']))

// Logical combinators
q.where(e => e.and(
  e.eq('status', 'active'),
  e.or(e.gt('age', 18), e.eq('role', 'admin')),
))

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
  .computed('ROW_NUMBER() OVER w', 'rank')

// Aggregates
q.aggregate(e => ({
  total: e.countCol(),
  maxPrice: e.max('price'),
  avgScore: e.avg('score'),
}))

// GROUP BY + HAVING
q.groupBy('department').having(e => e.gt('count', 5))
```

### Mutations

```ts
// Insert
await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
await repo.insertMany([{ ... }, { ... }])

// Update
await repo.updateMany({ status: 'active' }, e => e.eq('id', 1))
await repo.updateOne({ name: 'Bob' }, e => e.eq('id', 1))

// Delete
await repo.deleteOne(e => e.eq('id', 1))
await repo.deleteMany(e => e.lt('createdAt', cutoff))

// Upsert
await repo.findOrCreate({ email: 'a@test.com', name: 'Alice' }, ['email'])
```

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
await repo.updateWithLock(
  { name: 'Updated' },
  e => e.eq('id', 1),
  currentVersion,
)
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
  await txRepo.insertOne({ name: 'Alice', email: 'a@test.com' })

  // Savepoints
  try {
    await tx.savepoint(async (sp) => {
      await txRepo.insertOne({ name: 'Dupe', email: 'a@test.com' })
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
const page = await repo.paginate({ page: 1, perPage: 20 })
// { data, total, page, perPage, totalPages }

// Cursor-based (efficient for large datasets)
const page1 = await repo.paginateCursor({ take: 20, column: 'id' })
const page2 = await repo.paginateCursor({
  take: 20,
  column: 'id', cursor: page1.nextCursor,
})
```

## Streaming

```ts
for await (const row of repo.stream(q => q.where(e => e.eq('active', true)), { chunkSize: 500 })) {
  // process row
}
```

> **Note**: Streaming uses LIMIT/OFFSET chunking internally. If rows are inserted or deleted during iteration, rows may be skipped or duplicated. For correctness on mutable data during long-running streams, use cursor-based pagination with `paginateCursor()` instead, or run inside a `REPEATABLE READ` transaction.

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

### Known Limitations

- Foreign key constraints are only generated during `CREATE TABLE`. Adding `.references()` to an existing column will not generate `ALTER TABLE ADD CONSTRAINT` during sync. Workaround: use `db.raw()` to add FK constraints manually on existing tables.

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
  await repo.insertOne({ email: 'duplicate@test.com', name: 'Test' })
} catch (err) {
  if (err instanceof UniqueError) {
    console.log(`Duplicate on column: ${err.column}`)
  }
}
```

In production (`NODE_ENV=production`), error messages are sanitized to strip data values. Set `REDACT_QUERY_LOGS=1` to fully redact query SQL and params.

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

// Graceful close — drain: wait for in-flight queries before closing the pool.
await db.close({ drain: true, timeout: 5000 })
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
| `q.computedRaw(expr, alias)` | SELECT-list expression |
| `e.raw(sql, ...params)` | WHERE/ON fragment (positional `?` params are bound; the surrounding SQL is verbatim) |
| `db.raw(sql, params)` / tagged template | full query body |

Validation errors (invalid identifiers, non-finite numbers, unsafe delimiters,
injection-shaped raw fragments) throw `ValidationError extends OrmError`.

## License

MIT
