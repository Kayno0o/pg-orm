# Performance Guide

This guide documents performance characteristics, optimizations, and benchmarking results for @kaynooo/pg-orm.

## Table of Contents

- [Array Parsing Performance](#array-parsing-performance)
- [Query Performance](#query-performance)
- [Bulk Operations](#bulk-operations)
- [Connection Pooling](#connection-pooling)
- [Best Practices](#best-practices)

## Array Parsing Performance

### Overview

PostgreSQL returns arrays in text format like `{1,2,3}` or `{"a","b","c"}`. The ORM includes an optimized parser that handles both simple and complex arrays efficiently.

### Implementation Details

The array parser uses a **fast path / slow path** strategy:

1. **Fast Path** (90%+ of cases): Simple arrays without quotes
   - Numbers: `{1,2,3,4,5}`
   - Booleans: `{t,f,t,f}`
   - Strings without special chars: `{hello,world,test}`

2. **Slow Path**: Complex arrays with quotes and escapes
   - Strings with commas: `{"hello,world","test"}`
   - Strings with quotes: `{"hello\"world"}`
   - Strings with backslashes: `{"path\\to\\file"}`

### Benchmark Results

Tested on Bun 1.3.2 with 100,000 iterations:

#### Small Arrays (10 elements)
- Number array: 20ms (5M ops/sec)
- String array: 15ms (6.6M ops/sec)
- Boolean array: 12ms (8.3M ops/sec)

#### Medium Arrays (100 elements)
- Number array: 248ms (403K ops/sec)
- String array: 106ms (943K ops/sec)
- Boolean array: 68ms (1.5M ops/sec)

#### Large Arrays (1000 elements)
- Number array: 4044ms (25K ops/sec)
- String array: 948ms (105K ops/sec)
- Boolean array: 757ms (132K ops/sec)

#### Complex Quoted Strings (50 elements)
- With quotes and escapes: 117ms (428K ops/sec)

### Why This Implementation is Fast

1. **Avoids Unnecessary Work**
   - Single `includes('"')` check to detect quotes
   - No RegEx (RegEx has significant overhead)
   - No intermediate allocations

2. **Optimized for Common Case**
   - 90%+ of arrays are simple (no quotes)
   - Fast path uses simple string operations
   - String character access (`content[i]`) is highly optimized in modern JS engines

3. **Benchmarked Alternatives**
   - `charCodeAt()` loops: **30-70% slower** for small/medium arrays
   - Pre-allocated arrays: No performance benefit (JS engines optimize well)
   - Complex threshold logic: Adds overhead without benefit

### Performance Tips

```typescript
// ✅ GOOD: Use array fields for small-to-medium collections
const User = orm.entity('users', {
  tags: orm.array('string')        // Fast: ~1M ops/sec for 100 items
}).build()

// ⚠️ CAUTION: Very large arrays (1000+ items) are slower
const Post = orm.entity('posts', {
  keywords: orm.array('string')    // ~100K ops/sec for 1000 items
}).build()

// ✅ BETTER: Use pagination or JSONB for large collections
const Post = orm.entity('posts', {
  keywords: orm.jsonb<string[]>()  // More efficient for large arrays
}).build()
```

## Query Performance

### Query Builder Caching

The repository pre-computes expensive operations at construction time:

```typescript
// Cached once per repository instance
this.cachedSelectColumns = columns.join(', ')  // SELECT clause
this.columnNameMap = new Map()                  // Field → column mapping
this.autoUpdateColumns = [...]                  // Auto-update timestamp fields
```

**Benefit**: Eliminates repeated string building and mapping lookups on every query.

### Parameterized Queries

All queries use Bun's tagged template literals for automatic parameterization:

```typescript
// ✅ Automatically parameterized (no SQL injection risk)
await db`SELECT * FROM users WHERE email = ${userEmail}`

// Performance: ~1-2µs overhead per parameter
```

### SELECT Optimization

The ORM selects only defined fields, avoiding `SELECT *`:

```typescript
// ✅ GOOD: Explicit field selection
SELECT id, name, email, age FROM users

// ❌ AVOID: SELECT * has overhead
SELECT * FROM users
```

## Bulk Operations

### Bulk Insert Performance

Bulk operations use a single multi-row INSERT:

```typescript
// Benchmark: 1000 records
// Individual inserts: ~200ms (5K ops/sec)
// Bulk insert: ~5ms (200K ops/sec)
// Speedup: 40x faster
```

**Implementation:**
```sql
INSERT INTO users (name, email) VALUES
  ($1, $2),
  ($3, $4),
  ($5, $6)
-- Single query instead of 3 separate INSERTs
```

### Bulk Operation Limits

Default limit: 1,000 items per operation

```typescript
// ✅ GOOD: Process in batches
const batchSize = 1000
for (let i = 0; i < data.length; i += batchSize) {
  const batch = data.slice(i, i + batchSize)
  await users.createMany(batch)
}

// ❌ BAD: Exceeds limit
await users.createMany(arrayOf10000Items) // Throws BulkOperationError
```

### Skip Validation for Trusted Data

When inserting trusted data (e.g., from migrations), skip validation for speed:

```typescript
// 10-20% faster with skipValidation
await users.createMany(trustedData, { skipValidation: true })
```

⚠️ **Warning**: Only use with data you fully control. Invalid data will cause database errors.

## Connection Pooling

### Configuration

```typescript
await orm.connect({
  hostname: 'localhost',
  database: 'mydb',

  // Connection pool settings
  max: 20,        // Maximum connections (default: 10)
  min: 2,         // Minimum idle connections
  idleTimeout: 30 // Close idle connections after 30s
})
```

### Pool Size Guidelines

| Workload | Recommended `max` |
|----------|-------------------|
| Low traffic (< 10 req/s) | 5-10 |
| Medium traffic (10-100 req/s) | 10-20 |
| High traffic (> 100 req/s) | 20-50 |

**Formula**: `max = (core_count * 2) + effective_spindle_count`

For PostgreSQL on SSDs: `max = (core_count * 2)`

### Connection Reuse

```typescript
// ✅ GOOD: Reuse repository instances
const users = orm.repo(User)

app.get('/users', async () => {
  return users.findAll() // Reuses connection from pool
})

// ❌ BAD: Creating new repository per request
app.get('/users', async () => {
  const users = orm.repo(User) // Unnecessary overhead
  return users.findAll()
})
```

## Best Practices

### 1. Use Indexes

Always index foreign keys and frequently queried columns:

```typescript
const Post = orm.entity('posts', {
  authorId: orm.number()
    .foreignKey('users', 'id')  // Automatically creates index
}).build()

// Manual index for frequently filtered fields
await db`CREATE INDEX idx_posts_published_at ON posts(published_at)`
```

### 2. Limit Result Sets

Always use `limit()` or pagination:

```typescript
// ✅ GOOD: Limited results
const recentPosts = await posts.query()
  .orderBy('createdAt', 'DESC')
  .limit(50)
  .execute()

// ⚠️ CAUTION: May return millions of rows
const allPosts = await posts.findAll()
```

### 3. Use Projections

Select only needed fields:

```typescript
// ✅ GOOD: Select specific fields
const names = await users.query()
  .select('id', 'name')
  .execute()
// Returns: Array<{ id: number, name: string }>

// ❌ WASTEFUL: Fetches all fields
const users = await users.findAll()
const names = users.map(u => u.name)
```

### 4. Batch Related Queries

Avoid N+1 queries:

```typescript
// ❌ BAD: N+1 queries (1 + N database calls)
const posts = await posts.findAll()
for (const post of posts) {
  const author = await users.find(post.authorId) // N queries
}

// ✅ GOOD: Batch load (2 database calls)
const posts = await posts.findAll()
const authorIds = [...new Set(posts.map(p => p.authorId))]
const authors = await users.query()
  .whereIn('id', authorIds)
  .execute()

const authorMap = new Map(authors.map(a => [a.id, a]))
const postsWithAuthors = posts.map(p => ({
  ...p,
  author: authorMap.get(p.authorId)
}))
```

### 5. Use Transactions for Consistency

Group related operations:

```typescript
// ✅ GOOD: Atomic operation
await orm.transaction(async (tx) => {
  const txUsers = users.withTransaction(tx)
  const txPosts = posts.withTransaction(tx)

  const user = await txUsers.create({ ... })
  await txPosts.create({ authorId: user.id, ... })
})

// ❌ BAD: Race conditions possible
const user = await users.create({ ... })
await posts.create({ authorId: user.id, ... })
```

### 6. Enable Query Logging (Development)

Monitor slow queries:

```typescript
// Add after database connection
const db = orm.getDatabase()
db.query = new Proxy(db.query, {
  apply(target, thisArg, args) {
    const start = performance.now()
    const result = Reflect.apply(target, thisArg, args)
    const duration = performance.now() - start

    if (duration > 100) {
      console.warn(`Slow query (${duration}ms):`, args[0])
    }

    return result
  }
})
```

### 7. Use EXPLAIN for Query Analysis

Analyze query plans:

```typescript
const db = orm.getDatabase()

// Check if query uses indexes
const plan = await db`
  EXPLAIN ANALYZE
  SELECT * FROM posts WHERE author_id = 123
`

console.log(plan)
// Look for: "Index Scan" (good) vs "Seq Scan" (bad for large tables)
```

## Performance Checklist

- [ ] Use appropriate indexes on foreign keys and filtered columns
- [ ] Always limit result sets with `limit()` or pagination
- [ ] Use projections to select only needed fields
- [ ] Batch related queries to avoid N+1 problems
- [ ] Use transactions for multi-step operations
- [ ] Configure connection pool size appropriately
- [ ] Use bulk operations for inserting multiple records
- [ ] Skip validation only for trusted data
- [ ] Monitor slow queries in development
- [ ] Use EXPLAIN to analyze query plans

## Benchmarking Your Application

```typescript
import { performance } from 'node:perf_hooks'

async function benchmarkQuery(name: string, fn: () => Promise<any>, iterations = 100) {
  // Warmup
  await fn()

  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    await fn()
  }
  const end = performance.now()

  const avgMs = (end - start) / iterations
  console.log(`${name}: ${avgMs.toFixed(2)}ms avg`)
}

// Run benchmarks
await benchmarkQuery('Find by ID', () => users.find(1))
await benchmarkQuery('List 100 users', () => users.query().limit(100).execute())
await benchmarkQuery('Complex query', () =>
  users.query()
    .where('age', '>=', 18)
    .whereIn('role', ['admin', 'user'])
    .orderBy('name', 'ASC')
    .limit(50)
    .execute()
)
```

## Additional Resources

- [PostgreSQL Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)
- [Bun Performance](https://bun.sh/docs/runtime/performance)
- [Database Indexing Strategies](https://use-the-index-luke.com/)
