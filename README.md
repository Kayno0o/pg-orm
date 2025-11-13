<!-- eslint-disable -->
# ORM v2 - PostgreSQL ORM for Bun

A lightweight, type-safe ORM built specifically for Bun SQL with PostgreSQL support. Designed for simplicity, performance, and developer experience.

## Features

- **Decorator-based entity definitions** - Clean, declarative syntax with `@Entity` and `@Column`
- **Type-safe operations** - Full TypeScript support with automatic type inference
- **Async/await throughout** - All operations are asynchronous for PostgreSQL
- **Repository pattern** - Clean separation of concerns
- **Query builder** - Fluent API for complex queries
- **Foreign key support** - Built-in relationship handling
- **Bun SQL optimizations** - Leverages Bun's native SQL features:
  - Tagged template literals for SQL injection protection
  - Connection pooling
  - Prepared statements
  - PostgreSQL array support
  - RETURNING clauses for efficient inserts/updates

## Installation

```bash
bun install
```

## Quick Start

### 1. Set up PostgreSQL

Using Docker Compose:

```bash
bun run db:up
```

Or use your own PostgreSQL instance and set `DATABASE_URL` in `.env`:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/mydb
```

### 2. Define Entities

```typescript
import type { EntityInputType } from './src'
import { AbstractEntity, Column, Entity } from './src'

@Entity('tag')
export class Tag extends AbstractEntity {
  @Column('text', { nullable: false, unique: true })
  name!: string

  @Column('text', { nullable: true })
  description: string | null = null

  constructor(data?: EntityInputType<Tag>) {
    super()

    if (data) {
      this.name = data.name

      if (data.description !== undefined) {
        this.description = data.description
      }
    }
  }
}

@Entity('user')
export class User extends AbstractEntity {
  @Column('text', { nullable: false, unique: true })
  username!: string

  @Column('int', {
    nullable: true,
    reference: { table: 'tag', key: 'id' },
  })
  tag_id: number | null = null

  constructor(data?: EntityInputType<User>) {
    super()

    if (data) {
      this.username = data.username

      if (data.tag_id !== undefined) {
        this.tag_id = data.tag_id
      }
    }
  }

  async getTag(): Promise<Tag | null> {
    if (!this.tag_id)
      return null

    return await getRepository(Tag).find(this.tag_id)
  }
}
```

### 3. Initialize Database

```typescript
import { Tag } from './entities/Tag'
import { User } from './entities/User'
import { AbstractRepository, initDB } from './src'

await initDB(
  process.env.DATABASE_URL!,
  [
    new AbstractRepository(Tag),
    new AbstractRepository(User)
  ]
)
```

### 4. Use Repositories

```typescript
import { getRepository } from './src'

const userRepo = getRepository(User)
const tagRepo = getRepository(Tag)

// Create
const tag = await tagRepo.create({ name: 'admin' })
const user = await userRepo.create({
  username: 'john',
  tag_id: tag.id
})

// Find
const found = await userRepo.find(user.id)

// Find all
const allUsers = await userRepo.findAll()

// Find with conditions
const admins = await userRepo.findAllBy({
  where: { tag_id: tag.id },
  order: { username: 'asc' }
})

// Update
const updated = await userRepo.update(user.id, {
  username: 'jane'
})

// Delete
await userRepo.delete(user.id)
```

### 5. Entity Save Method

Entities have a convenient `save()` method:

```typescript
// Create new
const user = new User({ username: 'alice' })

await user.save() // Inserts and sets id

// Update existing
user.username = 'alicia'
await user.save() // Updates

console.log(user.id) // ID is set after first save
```

## API Reference

### Decorators

#### `@Entity(tableName, options?)`

Marks a class as a database entity.

```typescript
@Entity('users')
export class User extends AbstractEntity { }

// With composite unique constraints
@Entity('users', {
  unique: [['email', 'username']]
})
export class User extends AbstractEntity { }
```

#### `@Column(type, options?)`

Marks a property as a database column.

**Column Types:**
- `'text'` - TEXT (PostgreSQL)
- `'int'` - INTEGER
- `'float'` - REAL
- `'bool'` - BOOLEAN
- `'blob'` - BYTEA

**Options:**
- `nullable?: boolean` - Allow NULL values
- `unique?: boolean` - Add UNIQUE constraint
- `primary?: boolean` - Mark as primary key
- `default?: any` - Default value
- `name?: string` - Override column name
- `reference?: { table: string, key: string }` - Foreign key

```typescript
@Column('text', { nullable: false, unique: true })
username!: string

@Column('int', {
  nullable: true,
  reference: { table: 'tags', key: 'id' }
})
tag_id: number | null = null
```

### Repository Methods

All methods are async and return Promises.

#### `create(data)`

Insert a new entity.

```typescript
const user = await userRepo.create({ username: 'john' })
```

#### `find(id)`

Find by ID.

```typescript
const user = await userRepo.find(1)
// Returns User | null
```

#### `findAll()`

Get all entities.

```typescript
const users = await userRepo.findAll()
```

#### `findAllBy(options)`

Find with conditions.

```typescript
// By single value
const users = await userRepo.findAllBy({
  where: { username: 'john' }
})

// By array (IN clause using PostgreSQL arrays)
const users = await userRepo.findAllBy({
  where: { id: [1, 2, 3] }
})

// With ordering
const users = await userRepo.findAllBy({
  where: { active: true },
  order: { username: 'asc', id: 'desc' }
})

// With NOT NULL filter
const users = await userRepo.findAllBy({
  notNull: { tag_id: true }
})

// Combined filters
const users = await userRepo.findAllBy({
  where: { active: true },
  notNull: { email: true },
  order: { created_at: 'desc' }
})
```

#### `findOneBy(options)`

Find first matching entity.

```typescript
const user = await userRepo.findOneBy({
  where: { email: 'john@example.com' }
})
```

#### `update(id, data)`

Update an entity.

```typescript
const updated = await userRepo.update(1, {
  username: 'jane'
})
```

#### `delete(id)`

Delete an entity.

```typescript
await userRepo.delete(1)
```

#### `persist(data)`

Insert or update based on ID presence.

```typescript
// Insert (no id)
const user = await userRepo.persist({ username: 'john' })

// Update (with id)
const updated = await userRepo.persist({
  id: 1,
  username: 'jane'
})
```

### Query Builder

For complex queries:

```typescript
import { QueryBuilder } from './src'

const qb = new QueryBuilder<User>('user', 'u')

const users = await qb
  .select('u.id', 'u.username', 't.name as tag_name')
  .leftJoin('tag', 't', 'u.tag_id = t.id')
  .where('u.username LIKE $1', '%john%')
  .where('u.active = $1', true)
  .order('u.created_at', 'desc')
  .limit(10)
  .offset(20)
  .findAll()
```

**Methods:**
- `select(...fields)` - SELECT clause
- `join(table, alias, condition)` - INNER JOIN
- `leftJoin(table, alias, condition)` - LEFT JOIN
- `where(condition, ...params)` - WHERE clause (chainable)
- `groupBy(...fields)` - GROUP BY
- `having(condition, ...params)` - HAVING clause
- `order(field, direction)` - ORDER BY
- `limit(n)` - LIMIT
- `offset(n)` - OFFSET
- `findAll()` - Execute and return array
- `findOne()` - Execute and return first result
- `count()` - Count rows
- `build()` - Get [query, params] tuple

### Type Helpers

#### `EntityInputType<T>`

Automatically generates input types for constructors:

```typescript
// Excludes:
// - id field
// - Methods (functions)
// - Computed fields (getters, _private, etc.)
// Makes nullable/optional fields optional

constructor(data: EntityInputType<User>) {
  super()
  this.username = data.username // Required
  if (data.tag_id !== undefined) {
    this.tag_id = data.tag_id // Optional
  }
}
```

## Database Configuration

### Connection String

```typescript
await initDB(
  'postgres://user:pass@localhost:5432/mydb',
  repositories
)
```

### Configuration Object

```typescript
await initDB(
  {
    hostname: 'localhost',
    port: 5432,
    database: 'mydb',
    username: 'user',
    password: 'pass',
    max: 20, // Connection pool size
    idleTimeout: 30, // Idle timeout in seconds
    tls: true, // Enable SSL/TLS
  },
  repositories
)
```

## Testing

The ORM includes comprehensive unit tests using Bun's test runner.

### Run Tests

```bash
# Start PostgreSQL
bun run db:up

# Run tests
bun test

# Watch mode
bun run test:watch
```

### Test Structure

```
test/
├── entities/      # Test entity definitions
│   ├── Tag.ts
│   └── User.ts
├── setup.ts       # Test database setup
├── repository.test.ts
├── entity.test.ts
└── queryBuilder.test.ts
```

## Development Scripts

```bash
# Start PostgreSQL in Docker
bun run db:up

# Stop PostgreSQL
bun run db:down

# Reset database (drops all data)
bun run db:reset

# Run tests
bun test

# Watch mode for tests
bun run test:watch

# Build
bun run build
```

## Architecture

### Smart Bun SQL Features Used

1. **Tagged Template Literals** - Automatic SQL injection protection
2. **Prepared Statements** - Cached and optimized queries
3. **Connection Pooling** - Efficient connection management
4. **RETURNING Clause** - Single-query insert/update with result
5. **PostgreSQL Arrays** - Efficient IN clauses with `ANY(ARRAY[...])`
6. **Async/Await** - All operations are asynchronous

### Performance Optimizations

- Named prepared statements (automatic caching)
- Connection pool with configurable size
- Single-query create/update using RETURNING
- Bulk operations support
- Efficient array-based IN clauses

## Differences from v1

- **PostgreSQL only** (no SQLite support)
- **Fully async** - All methods return Promises
- **No migrations** - Manual schema management
- **Bun SQL native** - Uses Bun's SQL API instead of better-sqlite3
- **Enhanced performance** - Leverages PostgreSQL-specific features

## License

MIT

## Contributing

Contributions welcome! Please ensure tests pass before submitting PRs.

```bash
bun run db:up
bun test
```
