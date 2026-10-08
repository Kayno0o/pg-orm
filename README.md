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
- **SQLite** - the same schema, repositories and `sync()` on a SQLite file, from a `sqlite://` URL
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

// Write ops return the written row; pass `{ pk: true }` for only its primary key.
const alice = await UserRepo.write.insertOne({ name: 'Alice', email: 'alice@example.com' })

const allUsers = await UserRepo.read.findMany()

const filtered = await PostRepo.read.findMany(q =>
  q.where({ authorId: alice.id })
   .orderBy('id', 'desc')
   .limit(10),
)

await UserRepo.write.updateById(alice.id, { name: 'Alice Updated' })

await UserRepo.write.deleteById(alice.id)
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

A column is NOT NULL unless `.nullable()` says otherwise, in the database as in its inferred type; `.notNull()` only says so out loud.

```ts
t.text()                  // NOT NULL
t.text().nullable()       // NULL allowed, typed `string | null`
t.text().unique()         // UNIQUE constraint
t.text().primaryKey()     // PRIMARY KEY, required on insert unless it has a default (serial, defaultRaw)
t.text().default('val')   // DEFAULT, from a JS value
t.timestamptz().defaultRaw('now()') // DEFAULT, from raw SQL
t.int4().check('val > 0') // CHECK constraint
t.int4().generated('col1 + col2') // GENERATED ALWAYS AS ... STORED
t.int4().references(() => users, 'id', { onDelete: 'cascade' }) // FOREIGN KEY, the target as a thunk
t.int4().nullable().references('folders', 'id') // ...or by table name, which a self reference needs to stay typed
t.text().backfill('none')  // the value rows already there get when sync() adds this NOT NULL column; no DEFAULT is kept
t.timestamptz(3).defaultNow() // timestamptz(3) DEFAULT now(); timestamp, time and timetz take a precision too
t.int8().primaryKey().identity()                // GENERATED BY DEFAULT AS IDENTITY ({ always: true } for ALWAYS)
t.text().comment('The display name')             // COMMENT ON COLUMN
t.int4().references(() => Team, 'id', { deferrable: 'deferred' }) // DEFERRABLE INITIALLY DEFERRED
```

Table-level declarations chain on the definition:

```ts
defineTable('members', t => ({ ... }))
  .withUnique(['team_id', 'email'])           // UNIQUE (team_id, email), named members_team_id_email_key
  .withComment('People in a team')            // COMMENT ON TABLE
  .renamedFrom('users')                       // sync() renames "users" instead of dropping it
  .withIndexes([
    { columns: ['created_at'], desc: ['created_at'], include: ['email'] },
    { columns: ['email'], opclass: { email: 'text_pattern_ops' } },
    { name: 'members_lower_email', columns: [], expressions: ['lower(email)'] }, // @trusted SQL, needs a name
  ])
```

`CREATE INDEX CONCURRENTLY` is not available: every migration runs in one transaction, which Postgres refuses it in.

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

// Relation filtering: the target table, then a callback shaping its rows (where, orderBy, pick, computed, nested include)
const usersWithPublished = await UserRepo.read.findMany(q =>
  q.include('posts', posts, sq => sq.where({ published: true })),
)

// A callback limit and offset apply per parent: each user's three latest posts
const latest = await UserRepo.read.findMany(q => q.include('posts', posts, sq => sq.orderBy('createdAt', 'desc').limit(3)))

// A self reference nests like any other relation
const chain = await EmployeeRepo.read.findMany(q => q.include('manager', employees, m => m.include('manager')))

// A soft-delete target's trashed rows are left out, on every relation type, unless asked
const withTrashedPosts = await UserRepo.read.findMany(q => q.include('posts', posts, sq => sq.withTrashed()))
```

A callback limit is cut per parent with `ROW_NUMBER()` in the query, except on `hasManyThrough`, which reads every matching target and cuts in memory. The join columns must stay selected: a `pick()` or `omit()` leaving out the parent's key or the child's foreign key throws a `ValidationError`, as does a relation on a table with a composite primary key. `stream.offset()` loads includes on each chunk.

`withCount` adds each row's number of related rows as a column of the same query, instead of loading them. It counts `hasMany` and `hasManyThrough` relations, skips soft-deleted rows unless given `withDeleted: true`, and takes an alias and a filter typed against the target's columns (typed only for thunk relations):

```ts
const posts = await PostRepo.read.findMany(q =>
  q.withCount('comments').withCount('comments', { as: 'approvedCount', where: { approved: true } }),
)
// posts[0].commentsCount: number, posts[0].approvedCount: number
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
q.where({ name: { contains: 'dev' } })       // LIKE '%dev%', metacharacters escaped; iContains for ILIKE
q.where({ price: { between: [10, 100] } })
q.where({ deletedAt: { isNull: false } })
q.where({ tags: { eq: ['a', 'b'] } })        // an array column takes no bare array
```

Operators: `eq neq gt gte lt lte in notIn like ilike contains startsWith endsWith iContains iStartsWith iEndsWith between isNull`. `contains`, `startsWith` and `endsWith` match case; their `i` variants do not.

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
q.where(e => e.startsWith('name', 'Al'))   // LIKE 'Al%', matching case
q.where(e => e.iContains('bio', 'dev'))    // ILIKE '%dev%'
q.where(e => e.notLike('code', 'tmp-%'))   // notIlike too

// Null checks; IS DISTINCT FROM counts a null as a value
q.where(e => e.isNull('deletedAt'))
q.where(e => e.isDistinctFrom('status', 'done'))  // rows with a null status included

// COALESCE and CASE stand where a value goes, and in computed()
q.where(e => e.eq(e.coalesce('nickname', ''), ''))
q.computed(e => e.caseWhen([[e.gt('stock', 10), 'plenty'], [e.gt('stock', 0), 'low']], 'out'), 'availability')

// IN / NOT IN a subquery, any builder
q.where(e => e.inSubquery('authorId', db.repo(authors).read.select().pick('id').where({ verified: true })))

// JSONB
q.where(e => e.jsonbPath('metadata', '$.tags[*] ? (@ == "important")'))
q.where(e => e.jsonbContains('metadata', { tags: ['important'] }))  // @>

// Full-text search
q.where(e => e.tsMatch('searchVector', e.tsQuery('english', 'hello world')))

// ORDER BY an expression: pgvector distance, a CASE, a coalesce
q.orderBy(e => e.vectorCosineDistance('embedding', queryVector)).limit(10)
```

### JOINs, CTEs, Window Functions

```ts
// JOIN: given the table def, its columns are typed as `alias.col` in ON, where, orderBy and pick (nullable on a left or full join)
q.join(orders, 'o', e => e.eq('id', e.ref('o.userId'))).where({ 'o.status': 'paid' }).pick('id', 'name', 'o.total')
// rows: { id, name, 'o.total' }; with no pick a joined select returns only the table's own columns
q.leftJoin(profiles, 'p', e => e.eq('id', e.ref('p.userId')))

// Compare two columns: e.ref() stands where a value would
q.where(e => e.lt('stock', e.ref('minStock')))

// CTE: a builder, parameterized like any query, or trusted SQL
q.with('recent', db.repo(posts).read.select().pick('authorId').where(e => e.gt('createdAt', since)))
  .where(e => e.inSubquery('id', new SelectBuilder('recent').pick('authorId')))
q.with('active_users', 'SELECT * FROM users WHERE active = true')
q.withRecursive('tree', 'SELECT ... UNION ALL SELECT ...')

// Window functions over a declared window; a count, a sum or a rank reads back as a number
q.window('w', { partitionBy: ['department'], orderBy: [{ col: 'salary', dir: 'desc' }] })
  .computed(e => e.over(e.rowNumber(), 'w'), 'rank')        // rank(), denseRank() too
  .computed(e => e.over(e.sum('salary'), 'w'), 'running')

// Aggregates
q.aggregate(e => ({
  total: e.countCol(),
  maxPrice: e.max('price'),
  avgScore: e.avg('score'),
}))

// GROUP BY + HAVING — takes both WHERE forms; a grouped select always lists its group columns, before or after aggregate()
q.groupBy('department').having(e => e.gt('count', 5))
q.groupBy('department').aggregate(e => ({ total: e.countCol() })) // rows: { department, total }
q.aggregate(e => ({ authors: e.countDistinct('authorId') }))

// GROUP BY an expression. Each copy of an expression binds its own values, so one with bound values cannot be repeated in the select list or ORDER BY.
q.pick().computed(e => e.countCol(), 'n').groupByExpr(e => e.caseWhen([[e.gt('price', 100), 'premium']], 'standard'))
```

`pick()` and `omit()` reshape only the table columns: computed, `include` and `withCount` fields added before them stay. On a repository read, `omit()` lists the remaining columns rather than fetching `*`.

### Repository operation suites

Repository operations are grouped into three suites accessed as properties:

- `repo.read` — `findMany`, `findOne`, `findOneOrThrow`, `findById`, `findByIdOrThrow`, `existsById`, `count`, `exists`, `paginate`, `paginateCursor`, `select()`
- `repo.write` — `insertOne/Many`, `updateOne/Many/ById`, `updateWithLock`, `deleteOne/Many/ById`, `upsertOne/Many`, `findOrCreate`, `restore`, `forceDelete`, plus `insert/update/delete/merge/upsert` builders. These return the written row(s) with virtuals applied; pass `{ pk: true }` for only the primary key(s)
- `repo.stream` — `offset` (LIMIT/OFFSET) and `cursor` (keyset)

`db.repo(table)` is memoized per table definition, so calling it inline (`db.repo(users).read.findMany()`) on every request is free - no need to hoist repositories into module-level constants or wrap them in your own cache. The cache is keyed weakly on the table def and invalidated automatically when the def is mutated (`withRelations`, `withVirtuals`, `withTrait`, `hook`). `repo.using(tx)` is memoized per transaction client, so rebinding inside a loop is free too.

### Reads

```ts
await repo.read.findMany(q => q.where({ status: 'active' }).pick('id', 'name').limit(10))
await repo.read.count({ status: 'active' })
await repo.read.exists({ email: 'a@test.com' })

// A find that is only a WHERE takes the object, the shape count/exists/deleteMany take; a function is a select callback
await repo.read.findMany({ status: 'active' })
await repo.read.findOne({ email: 'a@test.com' })

// By primary key — a composite key takes an object holding each part
await repo.read.findById(1)
await repo.read.findById(1, q => q.pick('id', 'name').include('posts'))
await repo.read.findByIdOrThrow(1)      // throws NotFoundError instead of returning null
await repo.read.existsById(1)
await repo.read.existsById(1, { withTrashed: true })
await repo.read.findById({ userId: 1, groupId: 2 })

// Soft-delete tables: count/exists/paginate skip trashed rows unless asked
await repo.read.count({ status: 'active' }, { withTrashed: true })
```

### Mutations

Write operations return the **written row** with virtuals applied (an array for the `*Many` variants, `null` for the `*One` variants when nothing matched).
Pass `{ pk: true }` as the final argument to get only the primary key back, `RETURNING "id"` instead of `RETURNING *`: a single id, or an object holding each part of a composite key, the shape the by-id ops take.

```ts
// Insert — returns the written row
const alice = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' })
const rows = await repo.write.insertMany([{ ... }, { ... }])
// Past the bind-parameter limit (65535 on Postgres) insertMany/upsertMany split into several statements, run in one transaction (a savepoint inside a running one)

// ...or only its primary key with `{ pk: true }`
const id = await repo.write.insertOne({ name: 'Alice', email: 'a@test.com' }, { pk: true })

// Update — the where takes both forms, and `updateById` spells out the common one
await repo.write.updateMany({ status: 'active' }, { role: 'admin' })
// updateOne/deleteOne change only the first matching row by primary key, however many match
const updated = await repo.write.updateOne({ name: 'Bob' }, { id: 1 })
// ...or throw MultipleRowsError, changing nothing, when several match
await repo.write.updateOne({ name: 'Bob' }, { email }, { onMany: 'throw' })
await repo.write.deleteOne({ email }, { onMany: 'throw' })
await repo.write.updateById(1, { name: 'Bob' })

// One statement, a different value per row (reorders, tallies, sync diffs). Rows may write different columns.
await repo.write.updateManyById([{ id: 1, position: 0 }, { id: 2, position: 1, title: 'Renamed' }])

// Delete: a write refuses a missing WHERE, so clearing a table is its own op
await repo.write.deleteById(1)
await repo.write.deleteMany({ createdAt: { lt: cutoff } })
await repo.write.deleteAll()

// The raw update()/delete() builders refuse a statement left without a WHERE too, unless told
const { sql, params } = repo.write.delete().allRows().toSQL()

// ...and read other tables: UPDATE ... FROM and DELETE ... USING (Postgres), the other table's columns named `alias.col`
repo.write.update().from(stock, 's').set(e => ({ qty: e.ref('s.qty') })).where(e => e.eq('id', e.ref('s.itemId'))).returning()
repo.write.delete().using(bans, 'b').where(e => e.eq('email', e.ref('b.email')))

// INSERT ... SELECT, and ON CONFLICT DO NOTHING with no target skipping a row conflicting on any constraint
repo.write.insert().fromSelect(['id', 'name'], db.repo(drafts).read.select().pick('id', 'name')).onConflict().doNothing()

// Upsert — INSERT ... ON CONFLICT (conflictTarget) DO UPDATE
await repo.write.upsertOne({ key: 'theme', value: 'dark' }, ['key'])
await repo.write.upsertMany([{ ... }, { ... }], ['key'])

// ...restricting which columns the conflicting row gets updated with
await repo.write.upsertOne({ key: 'theme', value: 'dark', createdBy: 1 }, ['key'], ['value'])

// ...computing columns from the existing row: `u.existing(col)`, `u.excluded(col)`, `u.add`, `u.sub`, `u.coalesce`, `u.raw`
await repo.write.upsertOne({ uuid, name, sessions: 1, firstSeen: now }, ['uuid'], {
  set: u => ({
    sessions: u.add(u.existing('sessions'), 1),
    firstSeen: u.coalesce(u.existing('firstSeen'), u.excluded('firstSeen')),
  }),
})

// ...only when a guard holds (bare columns name the existing row); `null` when it skipped the update
const taken = await repo.write.upsertOne({ key: 'lock', value: token }, ['key'], { where: { value: '' } })

// Insert if missing, return the existing row otherwise - never overwrites; `created` says which
const { row: alice, created } = await repo.write.findOrCreate({ email: 'a@test.com', name: 'Alice' }, ['email'])
```

`conflictTarget` must be covered by a unique index (a unique column, or a composite
unique index declared via `withIndexes`), otherwise PostgreSQL rejects the statement.

An upsert that updates is an update: `beforeUpdate` hooks (so `timestamps()`'s `updatedAt`) and the optimistic-lock version bump apply to the row it updates. `findOrCreate` never touches the existing row, except to restore it: on a `softDelete` table, an upsert or a `findOrCreate` landing on a trashed row clears its `deletedAt` (it takes the incoming row's, null unless given), so neither hands back a row still trashed. `findOrCreate`'s restore is a `restore()`, so it runs the update hooks and reports `created: false`.

An upsert fires `afterInsert` for the rows it inserted and `afterUpdate` for the ones it updated (on SQLite, told apart by reading the conflicting keys first, so a row inserted concurrently in between counts as updated). `findOrCreate` fires `afterInsert` only when it created the row.

What each op gives when no row matches:

| Op | No match |
|----|----------|
| `findMany`, `*Many`, `deleteAll`, `restore`, `forceDelete` | `[]` |
| `findOne`, `findById`, `updateOne`, `updateById`, `deleteOne`, `deleteById` | `null` |
| `upsertOne` with a `where` guard that skipped the update | `null` |
| `findOneOrThrow`, `findByIdOrThrow` | throws `NotFoundError` |
| `updateWithLock` | throws `NotFoundError`, or `StaleRecordError` when the row is there at another version |
| `findOrCreate` | never misses: `{ row, created }` |

## Traits

```ts
import { defineTable, softDelete, timestamps, optimisticLock } from '@kaynooo/pg-orm'

const users = defineTable('users', t => ({ ... }))
  .withTrait(softDelete('deletedAt'))  // adds deletedAt column + isDeleted virtual
  .withTrait(timestamps())              // adds createdAt, updatedAt + auto-update hook
  .withTrait(optimisticLock())          // adds version column + auto-increment

// Soft-delete: deleteMany/deleteOne sets deletedAt instead of DELETE
// Use .withTrashed() to include soft-deleted rows, on a find, an include() callback or repo.read.select()
// Updates skip soft-deleted rows; pass { withTrashed: true } to reach them
// Use .forceDelete() for real DELETE

// Optimistic lock: updateWithLock() checks version, throws StaleRecordError on conflict, NotFoundError when no row matches
await repo.write.updateWithLock({ name: 'Updated' }, { id: 1 }, currentVersion)
```

### Schema introspection

Table and column metadata, typed — for generic code that derives request schemas, admin
UIs or CRUD routes from a table definition instead of restating its shape.

```ts
import { columnBaseType, hasTrait, isTableDef, tableMeta, traitColumns, writableColumns } from '@kaynooo/pg-orm'

Object.values(await import('./schema')).filter(isTableDef) // the tables among a module's exports

tableMeta(users).softDelete?.column   // 'deletedAt' — same for optimisticLock / timestamps
hasTrait(users, 'softDelete')         // true; works for custom traits by their `name`

traitColumns(users)                   // every column any trait added, custom traits included
writableColumns(users)                // all columns except the pk, generated and trait-managed ones
writableColumns(users, { exclude: ['ownerId'] })

columnBaseType(users.columns.tags)    // { base: 'text', isArray: true } — from 'text[]'
columnBaseType(users.columns.email)   // { base: 'varchar', isArray: false } — from 'varchar(255)'
```

**Column names known only at runtime** (a query string, a route config) go through without a cast. `repo.table` is the repository's table, typed for generic code; `isColumn` narrows a string to its column names and `whereColumn` builds a where object for one, throwing `ValidationError` on a name the table lacks.

```ts
async function list<C extends AnyColumns>(repo: Repository<C>, sort: string, field: string, search: string) {
  return repo.read.findMany(q => {
    if (isColumn(repo.table, sort))
      q.orderBy(sort)
    return q.where(whereColumn(repo.table, field, { iContains: search }))
  })
}
```

Every statement a repository runs checks its bare column names (WHERE, pick, omit, ORDER BY, GROUP BY, windows, RETURNING) against the table, and throws `ValidationError` before sending one it lacks: SQLite would read a double-quoted unknown name as a string literal, so `deleteMany({ nme: 'nme' })` would delete every row. A builder constructed on a table definition (`new SelectBuilder(users)`) checks the same way; one given only a table name checks nothing.

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

The `after*` hooks receive every written row whole and mapped, the same shape `afterSelect` gets, so a table with an after-write hook returns all its columns from each write. A write that touched no row fires no after-write hook.

## Transactions

```ts
await db.transaction(async (tx) => {
  const txRepo = UserRepo.using(tx)
  await txRepo.write.insertOne({ name: 'Alice', email: 'a@test.com' })

  // Savepoints: sp is a TransactionClient, the same nested transaction a db.transaction() call joins
  try {
    await tx.savepoint(async (sp) => {
      await UserRepo.using(sp).write.insertOne({ name: 'Dupe', email: 'a@test.com' })
    })
  } catch {
    // savepoint rolled back, outer tx continues
  }
})

// Called from inside a transaction body, db.transaction() joins it in a savepoint:
// a helper that opens its own transaction commits or rolls back with its caller's.
await db.transaction(async (tx) => {
  await createListWithTiers(input) // runs db.transaction() itself
  throw new Error('undoes the list too')
})
// { independent: true } opens a separate transaction on its own connection instead.

// With isolation level
await db.transaction(
  { isolation: 'serializable', accessMode: 'read write' },
  async (tx) => { ... },
)

// Rerun the whole body on a serialization failure or deadlock; only the last attempt's onCommit/onRollback callbacks run
await db.transaction({ isolation: 'serializable', retry: { maxRetries: 3 } }, async (tx) => { ... })
```

A read-only access mode is enforced on both dialects (`query_only` on SQLite). A transaction client is dead once its transaction settles: a query on it throws `ValidationError`, and a `db.transaction()` started by work that outlived the body (a timer) opens its own transaction instead of joining the finished one.

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

// Cursor-based (efficient for large datasets): ordered by the primary key unless `column` says otherwise
const page1 = await repo.read.paginateCursor({ take: 20 })
const page2 = await repo.read.paginateCursor({ take: 20, cursor: page1.nextCursor })

// Another column orders first and the primary key breaks its ties, so the cursor is { value, key }
const byDate = await repo.read.paginateCursor({ take: 20, column: 'createdAt', direction: 'backward', withTrashed: true }, q => q.pick('id', 'createdAt', 'name'))
```

`paginateCursor` and `stream.cursor` resume with a row-value comparison on (column, primary key), so tied values are neither skipped nor repeated and backward pages never overlap. The cursor is the primary key (an object of its parts on a composite key) when ordering by it, else `{ value, key }`. A nullable column is refused with a `ValidationError`, as is a callback setting `orderBy`, `limit` or `offset` or picking away a cursor column. `stream.offset()` orders by the primary key when the callback gives no order.

## Recipes

Which op fits which write. Each one is a single statement or a transaction, so two requests racing on the same row cannot both win.

**Get or create**: an insert that does nothing on conflict, then a read of the conflicting row; needs a unique index on the target.

```ts
const { row: tag, created } = await TagRepo.write.findOrCreate({ slug: 'bun', name: 'Bun' }, ['slug'])
```

**Insert or update**: `upsertOne` copies the incoming columns on conflict; `set` computes from the existing row instead, `where` skips the update (and returns `null`).

```ts
await StatRepo.write.upsertOne({ userId, day, visits: 1 }, ['userId', 'day'], {
  columns: [],
  set: u => ({ visits: u.add(u.existing('visits'), 1) }),
})
```

**Claim once** (redeem an invite, consume a token): put the condition in the WHERE, `null` means someone else got there first.

```ts
const claimed = await InviteRepo.write.updateOne({ usedBy: userId, usedAt: new Date() }, { token, usedAt: null })
if (!claimed)
  throw new Error('invite already used')
```

**Read, modify, write**: with the `optimisticLock` trait, `updateWithLock` throws `StaleRecordError` if the row changed since it was read. Without it, lock the row for the transaction with `forUpdate()`.

```ts
const doc = await DocRepo.read.findByIdOrThrow(id)
await DocRepo.write.updateWithLock({ body: edit(doc.body) }, { id }, doc.version)

await db.transaction(async (tx) => {
  const wallets = WalletRepo.using(tx)
  const wallet = await wallets.read.findOne(q => q.where({ id }).forUpdate())
  await wallets.write.updateById(id, { balance: wallet!.balance - amount })
})
```

The lock modes are `forUpdate()`, `forNoKeyUpdate()`, `forShare()` and `forKeyShare()`; `lockOf('t', 'alias')` locks only those tables of a join, and `skipLocked()` skips a locked row where `noWait()` fails at once on it.

**Several writes that must succeed together**: every repo in the body goes through `.using(tx)`; one that does not writes outside the transaction.

```ts
const list = await db.transaction(async (tx) => {
  const created = await ListRepo.using(tx).write.insertOne({ ownerId, title })
  await TierRepo.using(tx).write.insertMany(names.map((name, position) => ({ listId: created.id, name, position })))
  return created
})
```

**Replace a child collection**: delete and reinsert in one transaction (`forceDelete` on a soft-delete table), or reorder in place with `updateManyById`, one statement for every row.

```ts
await db.transaction(async (tx) => {
  const tiers = TierRepo.using(tx)
  await tiers.write.deleteMany({ listId })
  await tiers.write.insertMany(names.map((name, position) => ({ listId, name, position })))
})

await TierRepo.write.updateManyById(order.map((id, position) => ({ id, position })))
```

**Page a list**: `paginate` for numbered pages (its `total` follows the callback's filters), `paginateCursor` for infinite scroll. `withCount` adds child counts without a query per row.

```ts
const listing = await ListRepo.read.paginate({ page, perPage: 20, where: { ownerId } }, q => q.withCount('tiers').orderBy('id', 'desc'))
const next = await ListRepo.read.paginateCursor({ take: 20, column: 'id', direction: 'backward', cursor })
```

**Retry on a unique token collision**: needs a unique index on the token.

```ts
for (let attempt = 1; ; attempt++) {
  try {
    return await ShareRepo.write.insertOne({ listId, token: randomToken() })
  }
  catch (err) {
    if (!(err instanceof UniqueError) || attempt === 5)
      throw err
  }
}
```

## Streaming

```ts
// A WHERE object or a select callback, as findMany takes
for await (const row of repo.stream.offset({ active: true }, { chunkSize: 500 })) {
  // process row
}

// Cursor-based (safe for mutable data):
for await (const row of repo.stream.cursor({ chunkSize: 500 })) {
  // process row
}
```

> **Note**: `stream.offset()` uses LIMIT/OFFSET chunking internally. If rows are inserted or deleted during iteration, rows may be skipped or duplicated. For correctness on mutable data during long-running streams, use `stream.cursor()` instead, or run inside a `REPEATABLE READ` transaction.

## Migration

```ts
// Auto-sync: introspect DB + apply diff
const { sql, ops } = await db.sync({ dryRun: true })  // preview changes
await db.sync()                                         // apply changes
await db.sync({ allowDestructive: true })               // allow DROP TABLE/COLUMN
await db.rollback(2)                                    // run the down SQL of the last 2 migrations

// Check drift
const { hasDrift, drift } = await getMigrationStatus(db, db.getTablesRegistry())

// Generate migration file
const migration = await generateMigration(db, db.getTablesRegistry())
// { name, up, down }
```

`db.sync({ ignoreTables: ['legacy', /^tmp_/] })` neither creates, changes nor drops the tables named or matched.

### CLI

`pg-orm` reads `pg-orm.config.ts` from the current directory: `export default defineConfig({ db, migrationsDir?, ignoreTables? })`.

```sh
pg-orm status                       # drift and pending files
pg-orm generate                     # write a migration file from the drift
pg-orm apply                        # apply the pending files
pg-orm sync                         # generate, apply and record a migration, then write its file
pg-orm rollback 2
pg-orm new add_index                # an empty file to write by hand
```

- `--allow-destructive` lets `generate` and `sync` drop tables, columns and constraints; without it they refuse with `DestructiveOpError`.
- `--dry-run` prints what `generate`, `sync` or `apply` would do and changes nothing, destructive ops included.
- Each file, and each `sync`, is applied and recorded in one transaction holding an advisory lock: two deploys applying at once run each migration once, and a failed one leaves neither a record nor, for `sync`, a file.
- Each statement of a generated file sits under a comment naming its op, `-- Revert: ...` in the down half.

### Test databases

`testDatabase()` gives a test file a database of its own: a copy of one migrated from your migration files and seeded once, made with `CREATE DATABASE ... TEMPLATE`, which takes milliseconds. Tests run on the same schema production gets from `pg-orm apply`, and two files never see each other's rows, even when they run at once.

```ts
// tests/preload.ts, run before each file with `bun test --isolate --preload ./tests/preload.ts`
import { afterAll } from 'bun:test'
import { testDatabase } from '@kaynooo/pg-orm'
import { Member } from '../src/db/member'

const database = await testDatabase({
  url: process.env.DATABASE_URL!,   // the server's test database, from .env.test; it need not exist
  migrationsDir: 'migrations',
  tables: [Member],
  seed: async db => void await db.repo(Member).write.insertOne({ name: 'Ada' }),
})

process.env.DATABASE_URL = database.url // read by the app's Database, imported after this
afterAll(() => database.drop())
```

- The template is named after the database and a hash of the migration files and the seed function's source, so an edit to either builds a new one on the next run, which drops the one it replaces. Data the seed reads from elsewhere is not part of the hash.
- Runs racing to build the template each build their own and keep the first renamed into place.
- `drop()` drops the copy with `WITH (FORCE)`, closing the app's connections to it. A run that crashed leaves its copies, named `<database>_t<suffix>`.
- The user in `url` needs `CREATEDB`, and the server, Postgres 13 or later for `WITH (FORCE)`, a `postgres` database to connect to while creating them.
- Each file needs modules of its own for `DATABASE_URL` to differ between files: under plain `bun test` the preload runs once, and every file shares that one copy.

Each sync is recorded in `_pgorm_migrations` under a name unique to the millisecond plus a random suffix, with the down SQL reversing it. A drop, a type change or a SQLite rebuild has no reverse: `rollback()` refuses a migration holding one with a `MigrationError`, before running or recording anything. A rollback, like a sync, runs in one transaction holding an advisory lock.

### What sync() changes in place

- A new column comes with its UNIQUE constraint. A NOT NULL one without a default fails on a table with rows unless `.backfill(value)` gives them one: it is added with that value as its default, dropped in the same migration.
- A primary key added, moved or extended is applied: dropping the old one is destructive, and fails while foreign keys still point at it.
- A generated column whose expression changed gets `SET EXPRESSION` (Postgres 17 or later); one made plain keeps its values (`DROP EXPRESSION`); a plain column made generated is dropped and added again, which is destructive.
- A column renamed with `renamedFrom()` keeps its foreign key and its UNIQUE constraint, under their old names.
- A type change casts the values (`USING "col"::<type>`) unless Postgres converts them itself (text to varchar, int to bigint, date to timestamp), which refuses a value too long rather than cutting it. A json array becomes a Postgres array through its text. The column's default is dropped before and set again after.
- An enum losing values is replaced by a new type, every live column of it (arrays included) converted, its default dropped and set again. A row holding a removed value makes the sync fail.
- Index and constraint names longer than Postgres' 63 bytes are cut, with a hash of the full name kept.

### CHECK constraints

Each column's CHECKs (`.check()`, `.min()`, `.pattern()`, ...) are named `<table>_<column>_check_<hash>`, the hash taken from the expression, so `sync()` drops and re-adds a check whose expression changed. The first sync after upgrading renames the unnamed checks earlier versions created (`<table>_<column>_check`); checks named any other way are left alone.

### Foreign keys

Foreign key constraints are emitted as separate `add_fk` operations *after* all
`create_table` operations, so a FK-violating declaration order is safe on an empty
database. They are also diffed for existing tables: adding `.references()` to a
column generates `ALTER TABLE ... ADD CONSTRAINT` on the next `sync()`, removing it
generates a (destructive) `DROP CONSTRAINT`, and changing the target/`onDelete`/
`onUpdate` is detected as a change.

## SQLite

A `sqlite://` URL opens a SQLite file through `bun:sqlite` instead of a Postgres server: the same `defineTable()` schema, repositories, relations, traits, hooks, transactions and `sync()`.

```ts
const db = new Database({ url: 'sqlite://data/app.db', tables: [User, Post] }) // 'sqlite://:memory:' for an in-memory one
await db.sync()
```

The file and its directory are created on first use, in WAL mode, with foreign keys enforced. `db.dialect` says which one a database speaks.

**Storage.** Integers, serials and booleans are `INTEGER` (a boolean reads back as `true`/`false`), floats `REAL`, `numeric` `NUMERIC`, `bytea` `BLOB`, and everything else `TEXT`: a date is its ISO string, which sorts and compares in time order, and a json or array column its JSON text. An enum is `TEXT` with a CHECK on its values. A single serial or integer primary key is the rowid, `AUTOINCREMENT` for a serial so a deleted id is never handed out again. `int8` keeps its precision past 2^53. `now()` and `gen_random_uuid()` defaults become their SQLite equivalents.

**Migrations.** `sync()`, `generateMigration()`, `applyMigration()`, `rollback()` and `testDatabase()` work as they do on Postgres. A rename or a new column is made with `ALTER TABLE` where SQLite allows it; any other change (a type, a constraint, a default, a dropped column) rebuilds the table, the way SQLite documents it: a new table is created, the rows copied over, the old one dropped and the new one renamed, with foreign keys off for the duration and checked before the commit. Its declared indexes are recreated with it; an index, trigger or view made by hand on that table is not, and a view reading it makes the rebuild fail and roll back. A table created by other means than `sync()` is rebuilt once on the first `sync()`, its DDL spelled differently. `testDatabase()` copies a template file next to the app's database.

**Concurrency.** One connection per `Database`: transactions run one at a time, a query issued outside one waits for it, and a query issued from inside the body of one runs in it. Another process writing the same file is waited out for up to 5 seconds before `SerializationError`.

**What differs from Postgres:**

- `like()` is case-sensitive, through `GLOB`; `ilike()` ignores ASCII case only.
- Row locks (`forUpdate()`, `skipLocked()`, `noWait()`, `lockOf()`, ...) are dropped, SQLite locking the whole database for a write. Isolation levels and access modes are checked and then ignored: every transaction is serializable, and a `read only` one can still write.
- An independent transaction (`{ independent: true }`) cannot be opened from inside another one.
- Constraint errors map onto the same classes, named as Postgres would name them (`users_email_key`, `users_pkey`), a unique index by its columns too. A `ForeignKeyError` names neither its table nor its constraint, which SQLite does not report.
- `db.sql` is not a Bun SQL tag: use `db.raw()`.
- A `numeric` value is stored as a number: it reads back without trailing zeros (`19.9` for `19.90`), and rounded past 15 significant digits.
- Not supported, each throwing `DialectError`: `vector`, `tsvector` and full-text search, `jsonbPath()`, `.pattern()` (SQLite has no regular expressions), `distinctOn()`, `jsonbContains()`, `DELETE ... USING`, `merge()`, `explain({ analyze })`, `statementTimeout`, `idleInTransactionTimeout`, `getPoolStats()`, and a serial column that is not the single primary key. Raw SQL fragments and `jsonAgg()`, `arrayAgg()` or `jsonbAgg()` name Postgres functions, which SQLite does not have.

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
| `UniqueError` | 23505 | Unique constraint violation; `column` lists the key's columns |
| `ForeignKeyError` | 23503, 23001 | Foreign key violation: `table` holds the key, `referencedTable` the rows it points at |
| `NotNullError` | 23502 | NOT NULL violation |
| `CheckError` | 23514 | CHECK constraint violation |
| `ExclusionError` | 23P01 | Exclusion constraint violation |
| `TransactionAbortedError` | 25P02 | Statement sent to a transaction an earlier failure aborted |
| `InvalidQueryError` | 42xxx | Syntax error, unknown table or column, missing privilege (`code`) |
| `AuthenticationError` | 28xxx | Credentials refused, never retried |
| `ConnectionError` | 08xxx, 57P01-57P03, bun:sql connection timeouts | Connection lost, server shutting down or starting; a read retries it |
| `TimeoutError` | 57014, 55P03 | Statement or lock timeout, told apart by `code` |
| `StaleRecordError` | — | `updateWithLock` found the row at another version |
| `NotFoundError` | - | `findOneOrThrow`/`findByIdOrThrow` found nothing, or `updateWithLock` matched no row |
| `MultipleRowsError` | - | `updateOne`/`deleteOne` with `onMany: 'throw'` matched several rows; nothing changed |
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

Every error a query raises is a `QueryError` carrying its `query`, `params` and `table` (the one the database named, else the one the statement targets).

`QueryError` redaction is **safe-by-default**: with no `redactParams` configured, the
positional params on a `QueryError` are replaced with `'[REDACTED]'` placeholders so
values never leak into shared logs. The mode is resolved per error:

- `NODE_ENV=production` **or** `REDACT_QUERY_LOGS=1` — hard-redact: `query` becomes `'[REDACTED]'` and `params` becomes `[]`.
- `REDACT_QUERY_LOGS=0` — opt out entirely, in production too: raw SQL, params and driver messages are preserved verbatim, a `redactParams` included (use for local debugging only).
- Otherwise — apply the configured `redactParams` if set, else the safe default that scrubs every param.

In hard-redact mode no row value is reachable from an error: the message loses the values Postgres quotes back (`Key (email)=(...)`, `invalid input syntax for type uuid: "..."`), the raw driver error on `cause` is replaced by a copy holding only that message and its value-free fields (`code`, `errno`, `table`, `column`, `constraint`...), and `ValidationError.value` is `'[REDACTED]'`.

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

  // Schema sync() and the migration CLI introspect and create tables, types and the history table in (default: 'public').
  // Views in it are ignored. Queries at runtime still resolve names through the connection's search_path.
  schema: 'public',

  // statement_timeout (ms), set on every connection: plain queries and transactions alike
  statementTimeout: 30000,

  // idle_in_transaction_session_timeout (ms), set on every connection: kills connections that hold a transaction open without activity. The prod safety net for forgotten awaits.
  idleInTransactionTimeout: 60000,

  // Reported as application_name on the PG connection — shows up in pg_stat_activity
  // and PG logs for filtering and incident attribution.
  application_name: 'my-service',

  // Debug logging — prints every query with its $n placeholders filled in.
  // `true` logs to the console; pass a function to route lines elsewhere.
  // Ignored under NODE_ENV=production / REDACT_QUERY_LOGS=1.
  debug: process.env.DB_DEBUG === '1',

  // Query logging: hooks only observe, a throwing one never fails the query.
  // onError and a failing slow query's onSlowQuery event carry the error and durationMs.
  onQuery: (event) => console.log(event.sql, event.durationMs),
  onSlowQuery: (event) => console.warn(`Slow query: ${event.durationMs}ms`),
  slowQueryThreshold: 1000,

  // Receives what cannot be rethrown: a failing onCommit/onRollback callback,
  // a stream safety warning, a shutdown close, a throwing query hook (kind 'queryHook').
  // Without it, or when it throws itself, these go to console.warn.
  onCallbackError: ({ kind, error }) => log.error(`pg-orm ${kind} failed`, error),
})

// Health check
const ok = await db.ping()

// Format a QueryEvent yourself — same renderer the `debug` flag uses
import { formatQuery } from '@kaynooo/pg-orm'

formatQuery(event) // [0.412ms] SELECT * FROM "users" WHERE "email" = 'alice@example.com'
formatQuery(event, { colors: true, duration: false, maxParamLength: 40 })

// Graceful close — drain: wait for in-flight queries (at most `timeout` ms, 10 s by default) before closing the pool.
// New queries fail with ConnectionError as soon as close() starts, and are never retried; a transaction begun before still runs its queries.
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

  // Auto-retry deadlocks and serialization failures, and SELECTs after a dropped connection (judged by the leading keyword, so a raw SELECT calling a side-effecting function retries too).
  // A write is not retried after a drop, since it may have committed before the reply was lost; `writes: true` retries it anyway.
  // Does NOT retry inside a transaction: those bubble up (see `transaction({ retry })`). A retried statement reaches onQuery/onError once, with its final outcome.
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
// in-flight queries are aborted when the pool closes. The library installs no
// signal handler of its own and never exits the process: this one is yours.
process.on('SIGTERM', async () => {
  await db.close({ drain: true, timeout: 10_000 })
  process.exit(0)
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
| `e.raw(sql, ...params)` | WHERE/ON fragment (positional `?` params are bound, `??` is a literal `?` for the jsonb `?`, `?|`, `?&` operators, a `?` inside quotes is left alone; the surrounding SQL is verbatim) |
| `db.raw(sql, params)` / tagged template | full query body |

Validation errors (invalid identifiers, non-finite numbers, unsafe delimiters,
injection-shaped raw fragments) throw `ValidationError extends OrmError`.

## License

MIT
