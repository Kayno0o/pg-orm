# ORM v2 Architecture Guide

## High-Level Overview

**@kaynooo/pg-orm** is a lightweight, fully type-safe Object-Relational Mapping (ORM) library built specifically for Bun's SQL API with PostgreSQL support. It provides a modern builder pattern API inspired by Zod and Elysia for clean, type-inferred entity definitions.

**Project Type:** Personal Production Database ORM
**Target Runtime:** Bun
**Database:** PostgreSQL
**Language:** TypeScript
**Distribution:** bun package (@kaynooo/orm)

## Project Context

**This is a PERSONAL project for production use** - not intended for public distribution at this time.

### Documentation & Comments Policy

- **Minimize documentation**: Only document complex/non-obvious logic
- **Reduce comments**: Code should be self-explanatory through naming
- **Focus on functionality**: Prioritize working code over extensive guides
- **Production-ready**: Built for real-world use, not teaching/sharing

When working on this codebase:
- ✅ Write clean, self-documenting code
- ✅ Add comments only for complex algorithms or non-obvious behavior
- ✅ Keep existing critical documentation (MIGRATIONS.md, SECURITY.md, PERFORMANCE.md)
- ❌ Don't add JSDoc comments unless truly necessary
- ❌ Don't create excessive README sections
- ❌ Don't over-explain obvious patterns

## Key Differentiators

- **Builder Pattern:** Elysia-like object-based configuration with full type inference
- **Fully Type-Safe:** Complete TypeScript type inference - no type annotations needed
- **Multi-Instance Support:** Create multiple ORM instances for different databases or schemas (multi-tenant)
- **Bun-Native:** Leverages Bun's native SQL API with tagged template literals for SQL injection protection
- **PostgreSQL-First:** Optimized for PostgreSQL-specific features (arrays, JSONB, full-text search, etc.)
- **Plugin System:** Global and per-entity plugins via `.use()` for composable behaviors
- **Auto-Generated Repositories:** Repositories with `.extend()` capability for custom methods
- **Lifecycle Hooks:** Event-based hooks (beforeCreate, afterUpdate, etc.)
- **Composable Traits:** Mixin system for reusable entity behaviors
- **Zero Magic:** All operations explicit, no hidden query generation or auto-joins
- **Minimal Dependencies:** Only depends on bun-types

## Technology Stack

### Runtime & Build
- **Bun** - JavaScript runtime, test runner, and bundler
- **TypeScript** - Language for type safety (with experimental decorators **disabled**)
- **ESNext** - Target module system

### Key Dependencies
- **bun-types** - Type definitions for Bun API

### Database
- **Bun's SQL API** - Native SQL support with prepared statements, connection pooling
- **PostgreSQL** - Production database

### Development & Testing
- **Docker Compose** - PostgreSQL test environment (postgres:16-alpine)
- **bun:test** - Native test runner
- **ESLint** - Code linting

## New API Architecture

### Core Components

```
src/
├── orm.ts          # Main ORM class (supports multiple instances)
├── entity.ts       # EntityBuilder for defining schemas
├── field.ts        # Field type builders (string, number, etc.)
├── repository.ts   # Auto-generated Repository class
├── query.ts        # Fluent QueryBuilder
├── traits.ts       # Built-in traits and trait builder
├── db.ts           # Database connection management
├── types.ts        # TypeScript type system
├── errors.ts       # Error classes
└── index.ts        # Main exports
```

### Multi-Instance Architecture

The ORM supports **multiple independent instances**, each with its own:
- Database connection (separate PostgreSQL databases)
- Schema configuration (multi-tenant within same database)
- Entity registry (isolated or shared entities)
- Transaction scope
- Seeder/migration context

**Use Cases:**
1. **Multi-Database Applications:** Separate databases for users, analytics, audit logs
2. **Multi-Tenant SaaS:** Different PostgreSQL schemas per tenant (schema isolation)
3. **Microservices:** Each service has its own ORM instance and database
4. **Testing:** Isolated test instances with different schemas

**Basic Usage:**
```typescript
import { ORM, InMemoryCache } from '@kaynooo/orm'

// Create ORM instance with optional cache and logging
const orm = new ORM({
  cache: new InMemoryCache(60_000), // Optional: 60s default TTL
  logging: {
    enabled: true,
    logger: (entry) => console.log(`[${entry.operation}] ${entry.query}`)
  }
})

await orm.connect(process.env.DATABASE_URL!)

const User = orm.entity('users', f => ({ ... })).build()
```

**Multi-Database Usage:**
```typescript
import { ORM, InMemoryCache } from '@kaynooo/orm'

// Different databases with shared cache config
const cache = new InMemoryCache(60_000)

const userDb = new ORM({ cache })
const analyticsDb = new ORM({ cache })

await userDb.connect('postgresql://users_db')
await analyticsDb.connect('postgresql://analytics_db')

const User = userDb.entity('users', f => ({ ... })).build()
const Event = analyticsDb.entity('events', f => ({ ... })).build()

// Different schemas (multi-tenant)
const tenant1 = new ORM()
const tenant2 = new ORM()

await tenant1.connect({
  database: 'myapp',
  schema: 'tenant_1'  // PostgreSQL schema
})
await tenant2.connect({
  database: 'myapp',
  schema: 'tenant_2'
})

// Share entity definition across tenants
const User = tenant1.entity('users', f => ({ ... })).build()
tenant2.registerEntity(User)  // Reuse schema

const tenant1Users = tenant1.repo(User)
const tenant2Users = tenant2.repo(User)
```

**Limitations:**
- Cross-instance transactions are not supported
- Each ORM instance creates its own connection pool

## API Examples

### 1. Entity Definition (Elysia-like Builder)

```typescript
import { ORM, timestamps } from '@kaynooo/orm'

const orm = new ORM()

const User = orm
  .entity('users', f => ({
    name: f.string(),
    email: f.string().unique(),
    age: f.number().nullable(),
    role: f.enum(['admin', 'user', 'moderator']),
    metadata: f.jsonb<UserMeta>(),
    tags: f.array('string'),
  }))
  .use(timestamps()) // Adds createdAt, updatedAt
  .beforeCreate((data) => {
    data.email = data.email.toLowerCase()
  })
  .build()

// Type inference works automatically:
// typeof User = EntityDefinition<{
//   name: string,
//   email: string,
//   age: number | null,
//   role: 'admin' | 'user' | 'moderator',
//   metadata: UserMeta,
//   tags: string[],
//   createdAt: Date,
//   updatedAt: Date
// }>
```

### 2. Field Builders

```typescript
// Field builders are provided via callback in entity definitions
orm.entity('tableName', f => ({
  // String fields
  name: f.string().maxLength(255).minLength(3).unique(),

  // Number fields
  age: f.number().integer().min(0).max(100).default(0),

  // Boolean fields
  isActive: f.boolean().default(false),

  // JSON/JSONB fields
  metadata: f.jsonb<CustomType>().nullable(),
  data: f.json<any>(),

  // UUID fields
  uuid: f.uuid().unique().autoGenerate(),

  // Timestamp fields
  createdAt: f.timestamp().default('NOW()').autoUpdate(),

  // Date fields
  birthDate: f.date().nullable(),

  // Array fields
  tags: f.array('string'), // TEXT[]
  scores: f.array('number'), // INTEGER[]
  flags: f.array('boolean'), // BOOLEAN[]

  // Enum fields
  status: f.enum(['value1', 'value2', 'value3']),

  // Blob fields
  file: f.blob().nullable(),

  // Column name override
  displayName: f.string().column('custom_column_name'),
}))
```

### 3. Global & Per-Entity Plugins

```typescript
// Global plugins (apply to all entities)
orm.use(timestampsPlugin())
orm.use(softDeletePlugin())

// Per-entity plugins
const Post = orm
  .entity('posts', f => ({ ... }))
  .use(timestamps())
  .use(sluggable())
  .build()
```

### 4. Lifecycle Hooks

```typescript
const User = orm
  .entity('users', f => ({ ... }))
  .beforeCreate((data) => {
    data.email = data.email.toLowerCase()
  })
  .afterCreate(async (entity) => {
    await sendWelcomeEmail(entity.email)
  })
  .beforeUpdate((id, data) => {
    data.updatedAt = new Date()
  })
  .afterUpdate(async (entity) => {
    await clearCache(entity.id)
  })
  .beforeDelete(async (id) => {
    await cleanupFiles(id)
  })
  .afterDelete(async (id) => {
    await logDeletion(id)
  })
  .build()
```

### 5. Traits/Mixins

```typescript
import { createTrait, field, timestamps, softDelete, paranoid } from '@kaynooo/orm'

// Built-in traits
orm.entity('users', f => ({ ... })).use(timestamps())
orm.entity('posts', f => ({ ... })).use(softDelete())
orm.entity('comments', f => ({ ... })).use(paranoid()) // timestamps + softDelete

// Custom traits with .fields() callback
const customTrait = createTrait()
  .fields(f => ({
    published: f.boolean().default(false),
    publishedAt: f.timestamp().nullable(),
  }))
  .method('publish', async function(repo) {
    return repo.update(this.id, {
      published: true,
      publishedAt: new Date()
    })
  })
  .method('isPublished', function(_repo) {
    return this.published
  })
  .build()

const Post = orm.entity('posts', f => ({ ... })).use(customTrait)
```

### 6. Auto-Generated Repositories

```typescript
// Basic repository
const users = orm.repo(User)

// Extended repository with custom methods
const users = orm.repo(User).extend({
  async findByEmail(email: string) {
    return this.findOneBy({ where: { email } })
  },

  async findAdmins() {
    return this.findBy({ where: { role: 'admin' } })
  },

  async activate(id: number) {
    return this.update(id, { isActive: true })
  }
})

// All standard repository methods available:
// - find(id)
// - findAll()
// - findBy(options)
// - findOneBy(options)
// - create(data)
// - update(id, data)
// - delete(id)
// - count(options)
// - exists(id)
// - paginate({ page, pageSize, where, order })
// - createMany(dataArray)
// - deleteMany(ids)
// - query() // Returns QueryBuilder
// - transaction(callback)
// - withTransaction(tx)
```

### 7. Type-Safe Queries

```typescript
// Simple queries
await users.findBy({
  where: { role: 'admin', isActive: true },
  order: { createdAt: 'DESC' },
  limit: 10
})

// Advanced where conditions
await users.findBy({
  where: {
    age: { gte: 18, lte: 65 },
    role: { in: ['admin', 'moderator'] },
    email: { like: '%@example.com' },
    name: { ilike: '%john%' }
  }
})

// Pagination
const result = await users.paginate({
  page: 1,
  pageSize: 20,
  where: { isActive: true },
  order: { name: 'ASC' }
})
// result.data, result.total, result.page, result.pageSize, result.totalPages
```

### 8. Query Builder

```typescript
// Fluent API
const result = await users.query()
  .where('age', '>=', 18)
  .whereIn('role', ['admin', 'moderator'])
  .whereNotNull('email')
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

// Helper methods
await users.query().latest() // ORDER BY id DESC LIMIT 1
await users.query().oldest() // ORDER BY id ASC LIMIT 1
await users.query().random(5) // ORDER BY RANDOM() LIMIT 5
await users.query().count() // SELECT COUNT(*)
```

### 9. Transactions

```typescript
// Repository-scoped transaction
await users.transaction(async (txUsers) => {
  const user = await txUsers.create({ ... })
  await txUsers.update(user.id, { ... })
  // Auto-commit on success, auto-rollback on error
})

// Global transaction with multiple repositories
await orm.transaction(async (tx) => {
  const txUsers = users.withTransaction(tx)
  const txPosts = posts.withTransaction(tx)

  const user = await txUsers.create({ ... })
  await txPosts.create({ authorId: user.id, ... })
})
```

### 10. Database Connection

```typescript
// ORM instance configuration (cache, logging)
const orm = new ORM({
  cache: new InMemoryCache(60_000),
  logging: {
    enabled: true,
    logger: (entry) => {
      console.log(`[${entry.operation}:${entry.duration}ms] ${entry.query}`)
    }
  }
})

// Simple connection
await orm.connect(process.env.DATABASE_URL!)

// Advanced configuration
await orm.connect({
  hostname: 'localhost',
  port: 8532,
  database: 'mydb',
  username: 'user',
  password: 'pass',

  // Multi-tenant support
  schema: 'tenant_1',     // PostgreSQL schema (default: 'public')

  // Migration config
  migrations: {
    autoMigrate: true,      // Auto-detect schema changes
    noInteraction: false,   // Prompt before applying
    safeMigrations: true,   // Prevent DROP TABLE/COLUMN
  }
})

// Get raw database instance
const db = orm.getDB()
await db`SELECT * FROM custom_table`

// Get current schema
const schema = orm.getSchema()  // Returns 'tenant_1'

// Disconnect
await orm.disconnect()
```

### 11. Migrations

```typescript
// Auto-migration (on connect)
// Detects schema changes automatically and prompts

// Manual migrations via CLI
bun run migrate:create add_user_bio
bun run migrate:run
bun run migrate:rollback
bun run migrate:status
bun run migrate:generate  // From schema diff

// Programmatic API
await orm.migration.create('migration_name')
await orm.migration.run()
await orm.migration.rollback()
await orm.migration.reset()
await orm.migration.status()
await orm.migration.generate('name')
```

## Type System

The ORM uses advanced TypeScript mapped types for full type inference:

```typescript
type InferEntity<T extends EntitySchema> = {
  readonly id: number
} & {
  [K in keyof T]: InferField<T[K]>
}

type InferCreateData<T extends EntitySchema> = {
  [K in keyof T as T[K]['nullable'] extends true ? never : K]: InferField<T[K]>
} & {
  [K in keyof T as T[K]['nullable'] extends true ? K : never]?: InferField<T[K]>
}

type InferUpdateData<T extends EntitySchema> = Partial<{
  [K in keyof T]: InferField<T[K]>
}>
```

This means:
- **Entity types** are automatically inferred from schema
- **Create operations** require non-nullable fields, optional nullable fields
- **Update operations** make all fields optional
- **Query operations** are fully type-safe with autocomplete

## Migration from v1 (Decorator-Based)

### Old API (Decorators)
```typescript
@Entity('users')
class User extends AbstractEntity {
  @Column('text')
  name!: string

  @Column('text', { unique: true })
  email!: string

  @CreatedAt()
  createdAt!: Date
}

const userRepo = new UserRepository(User)
await initDB(connectionString, [userRepo])
```

### New API (Builder)
```typescript
const User = orm.entity('users', f => ({
  name: f.string(),
  email: f.string().unique(),
})).use(timestamps()).build()

await orm.connect(connectionString)
const users = orm.repo(User)
```

### Breaking Changes
- **No decorators** - Use builder pattern instead
- **No AbstractEntity** - Entities are plain objects
- **No explicit repository classes** - Use `.extend()` for custom methods
- **Different imports** - Import from single `orm` instance
- **Schema-first** - Define schema, get types automatically

## Breaking Changes in v3.0

### Field Builder Callback API

**This is a breaking API change from v2.x to v3.0.**

**Before (v2.x):**
```typescript
const User = orm.entity('users', f => ({
  name: f.string(),
  email: f.string().unique()
})
```

**After (v3.0):**
```typescript
const User = orm.entity('users', f => ({
  name: f.string(),
  email: f.string().unique()
}))
```

**Key Changes:**
- Entity definitions now use a callback pattern instead of object literal
- Field builders accessed via callback parameter (`f`) instead of `orm` instance
- Cleaner separation of concerns between ORM and field building
- Full type inference preserved - no TypeScript changes needed

**For Traits:**
Traits now use the `.fields()` callback pattern:

```typescript
// Before (v2.x)
const trait = createTrait()
  .field('count', field.number())
  .field('tags', field.array('string'))

// After (v3.0)
const trait = createTrait()
  .fields(f => ({
    count: f.number(),
    tags: f.array('string')
  }))
```

**Migration Steps:**
1. **Entity fields:** Find `orm.entity('tableName', {` → Replace with `orm.entity('tableName', f => ({`
2. **Field builders:** Find `orm.(string|number|...)` → Replace with `f.$1`
3. **Trait fields:** Find `.field('name', field.x())` → Replace with `.fields(f => ({ name: f.x() }))`
4. Combine multiple `.field()` calls into a single `.fields(f => ({ ... }))` call

## File Structure

### Core Files (Always Read These)
- `src/orm.ts` - Main ORM class
- `src/entity.ts` - Entity builder
- `src/field.ts` - Field builders
- `src/repository.ts` - Repository implementation
- `src/types.ts` - Type system
- `example.ts` - Usage examples

### Supporting Files (Read as Needed)
- `src/query.ts` - Query builder
- `src/traits.ts` - Trait system
- `src/db.ts` - Database connection
- `src/errors.ts` - Error classes

### Never Read (Unless Debugging)
- `dist/` - Build output
- `node_modules/` - Dependencies
- `.env` - Environment config
- `docker-compose.yml` - Infrastructure config

## Development Workflow

1. **Define entities** using builder pattern
2. **Run type check**: `bun run check`
3. **Test with watch**: `bun run test:watch`
4. **Run example**: `bun run example`
5. **Lint code**: `bun run lint:fix`
6. **Build distribution**: `bun run build`

## Claude Code Token Optimization

**Total src/ size:** ~50KB (~1000 lines across 11 files)

**Read in this order:**
1. `src/types.ts` - Type system (foundation)
2. `src/field.ts` - Field builders
3. `src/entity.ts` - Entity builder
4. `src/orm.ts` - Main ORM class
5. `src/repository.ts` - Repository implementation
6. `example.ts` - See it all in action

**Avoid reading:**
- Old test files (will be rewritten)
- Build output (`dist/`)
- Dependencies (`node_modules/`)
- Infrastructure configs

## Key Design Principles

✅ **Full type inference** - No manual type annotations
✅ **Immutable schemas** - Entity definitions frozen after `.build()`
✅ **Explicit operations** - No magic, all operations visible
✅ **PostgreSQL-first** - Leverage Bun SQL + PostgreSQL features
✅ **Composable** - Plugins, traits, hooks all composable
✅ **DX-focused** - Minimal boilerplate, excellent autocomplete
✅ **Builder pattern** - Chainable, discoverable API
