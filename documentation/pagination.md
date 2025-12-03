# Cursor-Based Pagination

This guide covers cursor-based pagination in @kaynooo/pg-orm, which provides better performance and consistency for large datasets compared to traditional offset-based pagination.

## Table of Contents

- [Why Cursor Pagination?](#why-cursor-pagination)
- [Basic Usage](#basic-usage)
- [Pagination with Filters](#pagination-with-filters)
- [Pagination with Sorting](#pagination-with-sorting)
- [Cursor vs Offset Comparison](#cursor-vs-offset-comparison)
- [Best Practices](#best-practices)

## Why Cursor Pagination?

### Problems with Offset Pagination

```typescript
// Traditional offset pagination
const page1 = await users.paginate({ page: 1, pageSize: 20 })
const page50 = await users.paginate({ page: 50, pageSize: 20 })
// Query: SELECT * FROM users LIMIT 20 OFFSET 980
// PostgreSQL must scan and skip 980 rows!
```

**Issues:**
- **Performance degradation** - Later pages require scanning all previous rows
- **Inconsistent results** - New inserts/deletes cause records to shift between pages
- **Resource intensive** - OFFSET requires counting rows that are then discarded

### Benefits of Cursor Pagination

```typescript
// Cursor-based pagination
const page1 = await users.paginateCursor({ pageSize: 20 })
const page2 = await users.paginateCursor({
  after: page1.nextCursor,
  pageSize: 20
})
// Query: SELECT * FROM users WHERE id > $1 LIMIT 20
// Direct index lookup - always fast!
```

**Benefits:**
- **Consistent performance** - Every page query is equally fast (index-based)
- **Stable results** - Cursors maintain position even with concurrent modifications
- **Efficient** - No row counting or skipping required
- **Perfect for infinite scroll** - Natural fit for modern UIs

## Basic Usage

### First Page

```typescript
import { orm } from '@kaynooo/pg-orm'

const User = orm.entity('users', {
  name: orm.string(),
  email: orm.string().unique(),
}).build()

const users = orm.repo(User)

// Get first page
const page1 = await users.paginateCursor({
  pageSize: 20
})

console.log(page1.data.length) // 20
console.log(page1.hasMore) // true
console.log(page1.nextCursor) // 20 (ID of last item)
```

### Next Pages

```typescript
// Get second page
const page2 = await users.paginateCursor({
  after: page1.nextCursor,
  pageSize: 20
})

console.log(page2.data.length) // 20
console.log(page2.hasMore) // true
console.log(page2.nextCursor) // 40

// Continue paginating
const page3 = await users.paginateCursor({
  after: page2.nextCursor,
  pageSize: 20
})
```

### Detecting Last Page

```typescript
let cursor: number | undefined
const allData = []

while (true) {
  const page = await users.paginateCursor({
    after: cursor,
    pageSize: 50
  })

  allData.push(...page.data)

  if (!page.hasMore) {
    // Reached the end
    console.log(page.nextCursor) // undefined
    break
  }

  cursor = page.nextCursor
}

console.log(`Loaded ${allData.length} total records`)
```

## Pagination with Filters

Cursor pagination works seamlessly with WHERE conditions:

```typescript
// Active users only
const activePage = await users.paginateCursor({
  pageSize: 20,
  where: { isActive: true }
})

// Multiple conditions
const filteredPage = await users.paginateCursor({
  pageSize: 20,
  where: {
    role: 'admin',
    isActive: true
  }
})

// Complex conditions (using query operators)
const complexPage = await users.paginateCursor({
  pageSize: 20,
  where: {
    age: { gte: 18, lte: 65 },
    email: { like: '%@company.com' }
  }
})

// Continue pagination with same filters
const nextPage = await users.paginateCursor({
  after: complexPage.nextCursor,
  pageSize: 20,
  where: {
    age: { gte: 18, lte: 65 },
    email: { like: '%@company.com' }
  }
})
```

**Important:** Always use the same WHERE conditions across all pages!

## Pagination with Sorting

Control the order of results:

```typescript
// Sort by name
const sortedPage = await users.paginateCursor({
  pageSize: 20,
  order: { name: 'ASC' }
})

// Sort by multiple fields
const multiSortPage = await users.paginateCursor({
  pageSize: 20,
  order: {
    role: 'ASC',
    name: 'ASC'
  }
})

// Descending order
const descPage = await users.paginateCursor({
  pageSize: 20,
  order: { createdAt: 'DESC' }
})
```

**Important:** Use the same ORDER BY across all pages!

## Cursor vs Offset Comparison

### Performance Comparison

```typescript
// Measure cursor pagination performance
const cursorStart = Date.now()
let cursor: number | undefined

for (let i = 0; i < 10; i++) {
  const page = await users.paginateCursor({
    after: cursor,
    pageSize: 100
  })
  cursor = page.nextCursor
  if (!page.hasMore) break
}

const cursorTime = Date.now() - cursorStart

// Measure offset pagination performance
const offsetStart = Date.now()

for (let i = 1; i <= 10; i++) {
  const page = await users.paginate({
    page: i,
    pageSize: 100
  })
}

const offsetTime = Date.now() - offsetStart

console.log(`Cursor: ${cursorTime}ms`)
console.log(`Offset: ${offsetTime}ms`)
console.log(`Cursor is ${(offsetTime / cursorTime).toFixed(2)}x faster`)
```

### Consistency Comparison

```typescript
// Offset pagination - inconsistent with concurrent writes
const offsetPage1 = await users.paginate({ page: 1, pageSize: 10 })

// Someone inserts a new user at the top
await users.create({ name: 'New User', email: 'new@example.com' })

const offsetPage2 = await users.paginate({ page: 2, pageSize: 10 })
// Problem: Last user from page 1 appears again in page 2!

// Cursor pagination - stable with concurrent writes
const cursorPage1 = await users.paginateCursor({ pageSize: 10 })

// Someone inserts a new user
await users.create({ name: 'New User', email: 'new@example.com' })

const cursorPage2 = await users.paginateCursor({
  after: cursorPage1.nextCursor,
  pageSize: 10
})
// ✓ No duplicates or missing records
```

## Best Practices

### 1. Choose the Right Pagination Method

**Use cursor pagination when:**
- Implementing infinite scroll UIs
- Dealing with large datasets (>10,000 records)
- Need consistent performance across pages
- Users frequently navigate to later pages
- Data changes frequently

**Use offset pagination when:**
- Users need page numbers (e.g., "Page 5 of 20")
- Dataset is small (<1,000 records)
- Need to jump to arbitrary pages
- Building traditional page navigation UI

### 2. Always Use Consistent Parameters

```typescript
// ✓ GOOD - Consistent parameters across pages
const params = {
  pageSize: 20,
  where: { isActive: true },
  order: { name: 'ASC' }
}

const page1 = await users.paginateCursor(params)
const page2 = await users.paginateCursor({
  ...params,
  after: page1.nextCursor
})

// ✗ BAD - Different parameters
const page1 = await users.paginateCursor({
  pageSize: 20,
  where: { isActive: true }
})

const page2 = await users.paginateCursor({
  after: page1.nextCursor,
  pageSize: 20,
  where: { isActive: false } // Different filter!
})
```

### 3. Handle Edge Cases

```typescript
// Check for empty results
const page = await users.paginateCursor({
  pageSize: 20,
  where: { role: 'nonexistent' }
})

if (page.data.length === 0) {
  console.log('No results found')
}

// Handle last page
if (!page.hasMore) {
  console.log('Reached the end')
  // nextCursor will be undefined
}

// Validate cursor before use
async function loadNextPage(cursor?: number) {
  if (cursor !== undefined && cursor < 0) {
    throw new Error('Invalid cursor')
  }

  return users.paginateCursor({
    after: cursor,
    pageSize: 20
  })
}
```

### 4. Store Cursors in State (React Example)

```typescript
import { useState } from 'react'

function UserList() {
  const [users, setUsers] = useState([])
  const [cursor, setCursor] = useState<number | undefined>()
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)

  const loadMore = async () => {
    if (loading || !hasMore) return

    setLoading(true)
    try {
      const page = await api.users.paginateCursor({
        after: cursor,
        pageSize: 20
      })

      setUsers(prev => [...prev, ...page.data])
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {users.map(user => (
        <UserCard key={user.id} user={user} />
      ))}

      {hasMore && (
        <button onClick={loadMore} disabled={loading}>
          {loading ? 'Loading...' : 'Load More'}
        </button>
      )}
    </div>
  )
}
```

### 5. Combine with Caching

```typescript
// Cache cursors and data
const cache = new Map<string, {
  data: any[]
  nextCursor?: number
  hasMore: boolean
}>()

async function getCachedPage(cacheKey: string, cursor?: number) {
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!
  }

  const page = await users.paginateCursor({
    after: cursor,
    pageSize: 20,
    where: { isActive: true }
  })

  cache.set(cacheKey, page)
  return page
}
```

## API Reference

### paginateCursor Options

```typescript
interface CursorPaginationOptions {
  /** Number of records to return per page */
  pageSize: number

  /**
   * Cursor (ID) to start after
   * Omit for first page
   */
  after?: number

  /** Filter conditions (same as findBy) */
  where?: WhereCondition<T>

  /** Sort order (same as findBy) */
  order?: OrderBy<T>
}
```

### CursorPaginationResult

```typescript
interface CursorPaginationResult<T> {
  /** Array of entities for this page */
  data: T[]

  /**
   * Cursor to use for next page
   * Undefined if no more pages
   */
  nextCursor?: number

  /** Whether more pages exist */
  hasMore: boolean
}
```

## Examples

### Infinite Scroll

```typescript
async function* infiniteScroll(pageSize = 50) {
  let cursor: number | undefined

  while (true) {
    const page = await users.paginateCursor({
      after: cursor,
      pageSize
    })

    yield page.data

    if (!page.hasMore) break
    cursor = page.nextCursor
  }
}

// Usage
for await (const users of infiniteScroll()) {
  console.log(`Processing ${users.length} users`)
  // Process batch
}
```

### Search with Pagination

```typescript
async function searchUsers(query: string, cursor?: number) {
  return users.paginateCursor({
    after: cursor,
    pageSize: 20,
    where: {
      name: { ilike: `%${query}%` }
    },
    order: { name: 'ASC' }
  })
}

// Load first page
const results = await searchUsers('john')

// Load more
if (results.hasMore) {
  const more = await searchUsers('john', results.nextCursor)
}
```

## See Also

- [Query Builder](../README.md#query-builder) - Advanced query patterns
- [Performance](../README.md#performance-optimizations) - Optimization tips
