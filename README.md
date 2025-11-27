# @kaynooo/pg-orm

A lightweight, fully type-safe ORM built specifically for Bun's SQL API with PostgreSQL support. Features a modern builder pattern API with complete TypeScript type inference.

[![npm version](https://img.shields.io/npm/v/@kaynooo/pg-orm.svg)](https://www.npmjs.com/package/@kaynooo/pg-orm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **🎯 Fully Type-Safe** - Complete TypeScript type inference, no manual type annotations needed
- **🚀 Builder Pattern API** - Fluent, chainable API inspired by Zod and Elysia
- **⚡ Bun-Native** - Leverages Bun's SQL API with tagged template literals for SQL injection protection
- **🐘 PostgreSQL-First** - Optimized for PostgreSQL-specific features (arrays, JSONB, full-text search)
- **🔌 Plugin System** - Global and per-entity plugins via `.use()` for composable behaviors
- **🪝 Lifecycle Hooks** - Event-based hooks (beforeCreate, afterUpdate, etc.)
- **🎭 Composable Traits** - Mixin system for reusable entity behaviors (timestamps, soft delete, etc.)
- **🔐 Security Built-In** - SQL injection protection, identifier validation, DoS prevention
- **📊 Auto-Migrations** - Automatic schema diffing and migration generation
- **🎨 Zero Magic** - All operations explicit, no hidden query generation or auto-joins

## Installation

```bash
bun add @kaynooo/pg-orm
```

## Quick Start

### 1. Connect to Database

```typescript
import { orm } from '@kaynooo/pg-orm'

await orm.connect(process.env.DATABASE_URL!)
// or with config object
await orm.connect({
  hostname: 'localhost',
  port: 5432,
  database: 'mydb',
  username: 'user',
  password: 'pass'
})
```

### 2. Define Entities

```typescript
import { orm } from '@kaynooo/pg-orm'

const User = orm
  .entity('users', {
    name: orm.string(),
    email: orm.string().unique(),
    age: orm.number().nullable(),
    role: orm.enum(['admin', 'user', 'moderator']),
    metadata: orm.jsonb<{ theme: string }>(),
    tags: orm.array('string'),
  })
  .beforeCreate((data) => {
    data.email = data.email.toLowerCase()
  })
  .build()

// Type inference works automatically - no manual types needed!
type UserEntity = InferEntity<typeof User.schema>
// {
//   readonly id: number
//   name: string
//   email: string
//   age: number | null
//   role: 'admin' | 'user' | 'moderator'
//   metadata: { theme: string }
//   tags: string[]
// }
```

### 3. Use Repositories

```typescript
const users = orm.repo(User)

// Create
const user = await users.create({
  name: 'John Doe',
  email: 'john@example.com',
  role: 'admin',
  metadata: { theme: 'dark' },
  tags: ['developer', 'admin']
})

// Find
const found = await users.find(user.id)
const allUsers = await users.findAll()

// Query with conditions
const admins = await users.query()
  .where('role', '=', 'admin')
  .where('age', '>=', 18)
  .orderBy('name', 'ASC')
  .execute()

// Update
const updated = await users.update(user.id, {
  name: 'Jane Doe'
})

// Delete
await users.delete(user.id)
```

## Core Concepts

### Field Builders

All field types have a fluent builder API:

```typescript
// String fields
orm.string()
  .maxLength(255)
  .minLength(3)
  .unique()
  .nullable()
  .default('default value')

// Number fields
orm.number()
  .integer()
  .min(0)
  .max(100)
  .default(0)
  .foreignKey('users', 'id', { onDelete: 'CASCADE' })

// Other field types
orm.boolean().default(false)
orm.uuid().autoGenerate()
orm.timestamp().default('NOW()').autoUpdate()
orm.date().nullable()
orm.array('string') // TEXT[]
orm.enum(['value1', 'value2', 'value3'])
orm.jsonb<CustomType>().nullable()
orm.blob()

// Custom column name
orm.string().column('custom_column_name')
```

### Traits (Mixins)

Reusable entity behaviors:

```typescript
import { timestamps, softDelete, paranoid } from '@kaynooo/pg-orm'

// Built-in traits
const User = orm
  .entity('users', { name: orm.string() })
  .use(timestamps()) // Adds createdAt, updatedAt
  .build()

const Post = orm
  .entity('posts', { title: orm.string() })
  .use(softDelete()) // Adds deletedAt
  .build()

const Comment = orm
  .entity('comments', { text: orm.string() })
  .use(paranoid()) // Combines timestamps + softDelete
  .build()

// Custom traits
const publishable = orm.trait()
  .fields({
    published: orm.boolean().default(false),
    publishedAt: orm.timestamp().nullable(),
  })
  .methods({
    async publish(this: Entity, repo: Repository) {
      return repo.update(this.id, {
        published: true,
        publishedAt: new Date()
      })
    },
    isPublished(this: Entity) {
      return this.published
    }
  })
  .build()

const Article = orm
  .entity('articles', { title: orm.string() })
  .use(publishable)
  .build()

const articles = orm.repo(Article)
const article = await articles.find(1)
await article.publish() // Trait method available!
```

### Lifecycle Hooks

```typescript
const User = orm
  .entity('users', {
    email: orm.string(),
    name: orm.string()
  })
  .beforeCreate((data) => {
    data.email = data.email.toLowerCase()
  })
  .afterCreate(async (entity) => {
    await sendWelcomeEmail(entity.email)
  })
  .beforeUpdate((id, data) => {
    console.log(`Updating user ${id}`)
  })
  .afterUpdate(async (entity) => {
    await clearCache(entity.id)
  })
  .beforeDelete(async (id) => {
    await cleanupUserData(id)
  })
  .afterDelete(async (id) => {
    await logDeletion(id)
  })
  .build()
```

### Extended Repositories

Add custom methods to repositories:

```typescript
const users = orm.repo(User).extend({
  async findByEmail(email: string) {
    return this.query()
      .where('email', '=', email)
      .findOne()
  },

  async findAdmins() {
    return this.query()
      .where('role', '=', 'admin')
      .execute()
  },

  async activate(id: number) {
    return this.update(id, { isActive: true })
  }
})

// Extended methods are fully typed
const user = await users.findByEmail('john@example.com')
const admins = await users.findAdmins()
```

### Query Builder

Type-safe fluent query API:

```typescript
const results = await users.query()
  .where('age', '>=', 18)
  .whereIn('role', ['admin', 'moderator'])
  .whereNotNull('email')
  .whereLike('name', '%John%')
  .orderBy('name', 'ASC')
  .limit(10)
  .offset(20)
  .execute()

// PostgreSQL-specific operators
await users.query()
  .whereJsonContains('metadata', { role: 'admin' })
  .whereJsonHasKey('metadata', 'preferences')
  .whereArrayContains('tags', 'developer')
  .whereArrayOverlaps('tags', ['admin', 'moderator'])
  .execute()

// Aggregations
const stats = await users.query()
  .where('isActive', '=', true)
  .groupBy('role')
  .countAs('total')
  .sum('age')
  .avg('age')
  .aggregate()

// Projections (select specific fields)
const names = await users.query()
  .select('id', 'name')
  .execute()
// Type: { id: number, name: string }[]

// Helper methods
await users.query().latest() // ORDER BY id DESC LIMIT 1
await users.query().oldest() // ORDER BY id ASC LIMIT 1
await users.query().random(5) // ORDER BY RANDOM() LIMIT 5
await users.query().count() // SELECT COUNT(*)
```

### Transactions

```typescript
// Repository-scoped transaction
await users.transaction(async (txUsers) => {
  const user = await txUsers.create({ name: 'John' })
  await txUsers.update(user.id, { name: 'Jane' })
  // Auto-commit on success, auto-rollback on error
})

// Global transaction with multiple repositories
await orm.transaction(async (tx) => {
  const txUsers = users.withTransaction(tx)
  const txPosts = posts.withTransaction(tx)

  const user = await txUsers.create({ name: 'John' })
  await txPosts.create({ authorId: user.id, title: 'Hello' })
})
```

### Bulk Operations

```typescript
// Bulk insert
const users = await userRepo.createMany([
  { name: 'User 1', email: 'user1@example.com' },
  { name: 'User 2', email: 'user2@example.com' },
  { name: 'User 3', email: 'user3@example.com' },
])

// Bulk delete
await userRepo.deleteMany([1, 2, 3])

// Skip validation for performance (when data is trusted)
await userRepo.createMany(largeDataset, { skipValidation: true })
```

### Pagination

```typescript
// Offset-based pagination
const result = await users.paginate({
  page: 1,
  pageSize: 20,
  where: { isActive: true },
  order: { name: 'ASC' }
})
// result.data, result.total, result.page, result.pageSize, result.totalPages

// Cursor-based pagination (better for large datasets)
const page1 = await users.paginateCursor({
  pageSize: 20,
  where: { isActive: true }
})

const page2 = await users.paginateCursor({
  after: page1.nextCursor,
  pageSize: 20,
  where: { isActive: true }
})
```

### Relations

```typescript
import { belongsTo, hasMany, hasOne } from '@kaynooo/pg-orm'

const User = orm.entity('users', {
  name: orm.string()
}).build()

const Post = orm.entity('posts', {
  title: orm.string(),
  authorId: orm.number().foreignKey('users', 'id', { onDelete: 'CASCADE' })
}).build()

const users = orm.repo(User)
const posts = orm.repo(Post)

// Load post's author (belongsTo)
const postAuthor = belongsTo('authorId', users)
const author = await postAuthor.load(post)

// Load user's posts (hasMany)
const userPosts = hasMany('authorId', posts)
const allPosts = await userPosts.load(user)

// Batch loading (prevents N+1 queries)
const allPosts = await posts.findAll()
const authorsMap = await postAuthor.loadMany(allPosts)
```

## Advanced Features

### Validation

Field-level validation with DoS protection:

```typescript
const User = orm.entity('users', {
  email: orm.string().maxLength(255),
  age: orm.number().min(0).max(150),
  role: orm.enum(['admin', 'user']),
  bio: orm.string().maxLength(1000)
}).build()

// Validation happens automatically on create/update
try {
  await users.create({
    email: 'a'.repeat(300), // Exceeds maxLength
    age: 200, // Exceeds max
    role: 'invalid', // Not in enum
  })
} catch (error) {
  if (error instanceof ValidationError) {
    console.log(error.errors) // Array of validation error details
  }
}
```

### Migrations

```typescript
// Auto-generate migration from schema changes
await orm.migration.generate('add_user_fields')

// Run pending migrations
await orm.migration.run()

// Rollback last batch
await orm.migration.rollback()

// Check migration status
await orm.migration.status()

// Reset all migrations
await orm.migration.reset()
```

### Security

Built-in protection against common vulnerabilities:

```typescript
// ✅ SQL injection protection via parameterized queries
await users.query().where('name', '=', "'; DROP TABLE users; --")
// Safe: becomes WHERE name = $1

// ✅ Identifier validation
orm.entity('users; DROP TABLE users; --', {}) // ❌ Throws InvalidIdentifierError

// ✅ DoS protection limits
await orm.connect({
  hostname: 'localhost',
  database: 'mydb',
  limits: {
    bulkOperations: 1000,
    arraySize: 1000,
    stringLength: 1_000_000,
    jsonSize: 10_000_000,
    jsonDepth: 32
  }
})
```

## API Reference

### ORM Class

```typescript
// Connection
await orm.connect(connectionString)
await orm.disconnect()
const db = orm.getDB()

// Entity definition
const Entity = orm.entity(tableName, fields).build()

// Repository access
const repo = orm.repo(Entity)

// Global plugins
orm.use(plugin)

// Transactions
await orm.transaction(callback)

// Migrations
await orm.migration.generate(name)
await orm.migration.run()
await orm.migration.rollback()
await orm.migration.status()
```

### Repository Methods

All methods return Promises:

```typescript
// CRUD
find(id): Promise<Entity | null>
findAll(): Promise<Entity[]>
findBy(options): Promise<Entity[]>
findOneBy(options): Promise<Entity | null>
create(data): Promise<Entity>
update(id, data): Promise<Entity>
delete(id): Promise<void>

// Bulk operations
createMany(dataArray): Promise<Entity[]>
deleteMany(ids): Promise<void>

// Queries
query(): QueryBuilder<T>
count(exact?): Promise<number>
exists(id): Promise<boolean>

// Pagination
paginate(options): Promise<PaginationResult>
paginateCursor(options): Promise<CursorPaginationResult>

// Transactions
transaction(callback): Promise<R>
withTransaction(tx): Repository

// Extensions
extend(methods): Repository & Methods
```

### Type Inference Helpers

```typescript
import type { InferEntity, InferCreateData, InferUpdateData } from '@kaynooo/pg-orm'

const User = orm.entity('users', {
  name: orm.string(),
  email: orm.string(),
  age: orm.number().nullable()
}).build()

type UserEntity = InferEntity<typeof User.schema>
// { readonly id: number, name: string, email: string, age: number | null }

type UserCreateData = InferCreateData<typeof User.schema>
// { name: string, email: string, age?: number | null }

type UserUpdateData = InferUpdateData<typeof User.schema>
// Partial<{ name: string, email: string, age: number | null }>
```

## Configuration

### Database Config

```typescript
await orm.connect({
  hostname: 'localhost',
  port: 5432,
  database: 'mydb',
  username: 'user',
  password: 'pass',

  // Connection pool
  max: 20,
  idleTimeout: 30,

  // Security limits
  limits: {
    bulkOperations: 1000,
    arraySize: 1000,
    stringLength: 1_000_000,
    jsonSize: 10_000_000,
    jsonDepth: 32
  },

  // Validation
  validation: {
    strict: false // If true, skipValidation is not allowed
  },

  // Migrations
  migrations: {
    autoMigrate: false,
    directory: './migrations'
  }
})
```

## Testing

```bash
# Start PostgreSQL
bun run db:up

# Run tests
bun test

# Watch mode
bun run test:watch

# Type checking
bun check
```

## Documentation

- [Security Guide](./docs/SECURITY.md) - SQL injection protection, DoS prevention
- [Performance Guide](./docs/PERFORMANCE.md) - Optimization tips and benchmarks
- [Migration Guide](./docs/MIGRATION.md) - Migrating from v1 to v2
- [Relations Guide](./docs/relations.md) - Working with foreign keys and relations
- [Pagination Guide](./docs/pagination.md) - Cursor and offset pagination

## Examples

See the [examples](./examples) directory for complete working examples:

- Basic CRUD operations
- Complex queries with joins
- Transaction management
- Custom traits and plugins
- Bulk operations
- Real-world application structure

## Differences from v1

**Breaking Changes:**
- No decorators - use builder pattern instead
- No `AbstractEntity` - entities are plain objects
- No explicit repository classes - use `.extend()` for custom methods
- Schema-first design - define schema, get types automatically
- Nullable fields now `T | null` instead of `T | null | undefined`

**Migration:** See [MIGRATION.md](./docs/MIGRATION.md) for detailed migration guide

## Contributing

Contributions are welcome! Please ensure tests pass before submitting PRs:

```bash
bun run db:up
bun test
bun check
```

## License

MIT

## Credits

Built with ❤️ for the Bun ecosystem.

Inspired by Prisma, Drizzle, Zod, and Elysia.
