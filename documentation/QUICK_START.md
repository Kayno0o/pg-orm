# Quick Start Guide

Get started with @kaynooo/pg-orm in 5 minutes.

## Installation

```bash
bun add @kaynooo/pg-orm
```

## Basic Usage

### Step 1: Connect to Database

```typescript
import { orm } from '@kaynooo/pg-orm'

await orm.connect({
  hostname: 'localhost',
  port: 5432,
  database: 'mydb',
  username: 'postgres',
  password: 'postgres',
})
```

### Step 2: Define Your First Entity

```typescript
import { orm, timestamps } from '@kaynooo/pg-orm'

const User = orm
  .entity('users', {
    name: f.string(),
    email: f.string().unique(),
    age: f.number().nullable(),
  })
  .use(timestamps()) // Adds createdAt, updatedAt
  .build()
```

### Step 3: Create a Repository

```typescript
const users = orm.repo(User)
```

### Step 4: Perform CRUD Operations

```typescript
// Create
const user = await users.create({
  name: 'Alice',
  email: 'alice@example.com',
  age: 25,
})

// Find by ID
const found = await users.find(user.id)

// Find all
const allUsers = await users.findAll()

// Query with conditions
const adults = await users.query()
  .where('age', '>=', 18)
  .orderBy('name', 'ASC')
  .execute()

// Update
await users.update(user.id, {
  age: 26,
})

// Delete
await users.delete(user.id)
```

## Auto-Migration

The ORM automatically detects schema changes and prompts you to apply them:

```typescript
// On first connection, the ORM will:
// 1. Detect that the 'users' table doesn't exist
// 2. Show you the SQL to create it
// 3. Ask if you want to apply the changes

// 🔍 Schema changes detected:
// ────────────────────────────────────────────────────────────
//   Create table users
//   Add UNIQUE constraint to users.email
// ────────────────────────────────────────────────────────────
//
// Apply these changes? [y/n]:
```

Type `y` and press Enter. Your database is now ready!

## Working with Relations

```typescript
const Post = orm
  .entity('posts', {
    title: f.string(),
    content: f.string(),
    authorId: f.foreignKey('users'),
  })
  .build()

const posts = orm.repo(Post)

// Create a post
const post = await posts.create({
  title: 'My First Post',
  content: 'Hello, world!',
  authorId: user.id,
})

// Find posts by author
const userPosts = await posts.query()
  .where('authorId', '=', user.id)
  .execute()
```

## Type Safety

Everything is fully typed:

```typescript
// ✅ TypeScript knows the exact types
const user = await users.create({
  name: 'Bob',        // ✅ string
  email: 'bob@...',   // ✅ string
  age: 30,            // ✅ number | undefined (nullable)
})

// ❌ Type error: property 'role' does not exist
await users.create({
  name: 'Bob',
  email: 'bob@...',
  role: 'admin', // ❌ Error!
})

// ✅ Queries are type-safe too
const adults = await users.query()
  .where('age', '>=', 18) // ✅ age is a valid column
  .where('role', '=', 'admin') // ❌ Error: 'role' doesn't exist
  .execute()
```

## Advanced Features

### Bulk Operations

```typescript
// Bulk insert (40x faster than individual inserts)
await users.createMany([
  { name: 'Alice', email: 'alice@...' },
  { name: 'Bob', email: 'bob@...' },
  { name: 'Charlie', email: 'charlie@...' },
])

// Bulk delete
await users.deleteMany([1, 2, 3])
```

### Pagination

```typescript
const page = await users.paginate({
  page: 1,
  pageSize: 20,
  where: { age: { gte: 18 } },
  order: { name: 'ASC' },
})

console.log(page.data)        // Current page results
console.log(page.total)       // Total count
console.log(page.totalPages)  // Number of pages
```

### Transactions

```typescript
await orm.transaction(async (tx) => {
  const txUsers = users.withTransaction(tx)
  const txPosts = posts.withTransaction(tx)

  const user = await txUsers.create({ name: 'Alice', email: 'alice@...' })
  await txPosts.create({ title: 'Post', authorId: user.id })

  // Auto-commit on success, auto-rollback on error
})
```

### Lifecycle Hooks

```typescript
const User = orm
  .entity('users', {
    email: f.string().unique(),
    name: f.string(),
  })
  .beforeCreate((data) => {
    data.email = data.email.toLowerCase()
  })
  .afterCreate(async (entity) => {
    await sendWelcomeEmail(entity.email)
  })
  .build()
```

### Traits

```typescript
import { orm, timestamps, softDelete, paranoid } from '@kaynooo/pg-orm'

// Timestamps: adds createdAt, updatedAt with auto-update
const User = orm
  .entity('users', { name: f.string() })
  .use(timestamps())
  .build()

// Soft Delete: adds deletedAt field
const Post = orm
  .entity('posts', { title: f.string() })
  .use(softDelete())
  .build()

// Paranoid: timestamps + soft delete
const Comment = orm
  .entity('comments', { content: f.string() })
  .use(paranoid())
  .build()
```

### Custom Repository Methods

```typescript
const users = orm.repo(User).extend({
  async findByEmail(email: string) {
    return this.findOneBy({ where: { email } })
  },

  async findAdmins() {
    return this.query()
      .where('role', '=', 'admin')
      .execute()
  },

  async activate(id: number) {
    return this.update(id, { active: true })
  },
})

// Use custom methods
const user = await users.findByEmail('alice@example.com')
const admins = await users.findAdmins()
```

## Configuration Options

```typescript
await orm.connect({
  // Connection
  hostname: 'localhost',
  port: 5432,
  database: 'mydb',
  username: 'postgres',
  password: 'postgres',

  // Auto-migration (default: true)
  autoMigrate: true,

  // Security
  maxJsonDepth: 32,        // Prevent deeply nested JSON
  maxArrayLength: 10000,   // Prevent huge arrays
  maxStringLength: 1000000, // Prevent huge strings

  // Safe migrations (default: true)
  safeMigrations: true, // Prevents DROP TABLE, DROP COLUMN

  // Non-interactive mode for CI/CD
  noInteraction: false,
})
```

## Next Steps

- 📖 **[Migration Guide](./MIGRATIONS.md)** - Learn about migrations
- 🔐 **[Security Guide](./SECURITY.md)** - Security best practices
-  **[Pagination Guide](./pagination.md)** - Pagination patterns

## Getting Help

- 📚 **Documentation**: [github.com/kaynooo/pg-orm/docs](https://github.com/kaynooo/pg-orm/tree/main/docs)
- 🐛 **Issues**: [github.com/kaynooo/pg-orm/issues](https://github.com/kaynooo/pg-orm/issues)
- 💬 **Discussions**: [github.com/kaynooo/pg-orm/discussions](https://github.com/kaynooo/pg-orm/discussions)

## Common Patterns

### Environment-Based Configuration

```typescript
const config = {
  hostname: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME!,
  username: process.env.DB_USER!,
  password: process.env.DB_PASSWORD!,
}

await orm.connect(config)
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  await orm.disconnect()
  process.exit(0)
})
```

### Testing Setup

```typescript
import { orm } from '@kaynooo/pg-orm'
import { beforeAll, afterAll } from 'bun:test'

beforeAll(async () => {
  await orm.connect({
    hostname: 'localhost',
    database: 'test_db',
    autoMigrate: true,
    noInteraction: true, // Don't prompt in tests
  })
})

afterAll(async () => {
  await orm.disconnect()
})
```

## FAQ

**Q: Do I need to write migrations manually?**

A: No! The ORM automatically detects schema changes. But you can write manual migrations for complex data transformations.

**Q: Is it safe for production?**

A: Yes! With `safeMigrations: true` (default), destructive operations like DROP TABLE are prevented. The ORM includes SQL injection protection, identifier validation, and DoS prevention.

**Q: How do I disable auto-migration?**

A: Set `autoMigrate: false` in the connection config.

**Q: Can I use it with TypeScript?**

A: Yes! It's built for TypeScript with full type inference. No manual type annotations needed.

**Q: Does it work with Bun only?**

A: Currently yes. It's built specifically for Bun's SQL API. Node.js support may come later.

**Q: How do I handle migrations in production?**

A: Use `noInteraction: true` to auto-apply safe changes, or set `autoMigrate: false` and use manual migrations.

---

**Ready to build something awesome? Start coding! 🚀**
