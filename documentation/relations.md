# Relations

This guide covers how to work with relations (foreign keys and relation loaders) in @kaynooo/pg-orm.

## Table of Contents

- [Defining Foreign Keys](#defining-foreign-keys)
- [Loading Related Data](#loading-related-data)
  - [belongsTo (Many-to-One)](#belongsto-many-to-one)
  - [hasMany (One-to-Many)](#hasmany-one-to-many)
  - [hasOne (One-to-One)](#hasone-one-to-one)
- [Batch Loading (N+1 Prevention)](#batch-loading-n1-prevention)
- [Complete Example](#complete-example)

## Defining Foreign Keys

Define foreign keys on number fields using the `.foreignKey()` method:

```typescript
import { orm } from '@kaynooo/pg-orm'

const Post = orm.entity('posts', {
  title: orm.string(),
  content: orm.string(),
  authorId: orm.foreignKey('users', 'id', {
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION'
  }),
}).build()
```

### Foreign Key Options

```typescript
orm.foreignKey(
  'table_name',    // Referenced table
  'column_name',   // Referenced column (default: 'id')
  {
    onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION',
    onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
  }
)
```

**Common patterns:**

```typescript
// CASCADE - Delete related records when parent is deleted
authorId: orm.foreignKey('users', 'id', {
  onDelete: 'CASCADE'
})

// SET NULL - Set to null when parent is deleted (requires nullable field)
assigneeId: orm.number().nullable().foreignKey('users', 'id', {
  onDelete: 'SET NULL'
})

// RESTRICT - Prevent deletion if related records exist
customerId: orm.foreignKey('customers', 'id', {
  onDelete: 'RESTRICT'
})

// Default (NO ACTION)
categoryId: orm.foreignKey('categories')
```

## Loading Related Data

The ORM provides three relation helpers for loading related entities:

### belongsTo (Many-to-One)

Load the parent entity that a foreign key points to.

```typescript
import { belongsTo, orm } from '@kaynooo/pg-orm'

const User = orm.entity('users', {
  name: orm.string(),
  email: orm.string().unique(),
}).build()

const Post = orm.entity('posts', {
  title: orm.string(),
  authorId: orm.foreignKey('users'),
}).build()

const users = orm.repo(User)
const posts = orm.repo(Post)

// Define the relation
const postAuthor = belongsTo('authorId', users)

// Load single post's author
const post = await posts.find(1)
const author = await postAuthor.load(post)

console.log(author?.name) // "John Doe"
```

### hasMany (One-to-Many)

Load all child entities that reference the parent.

```typescript
import { hasMany, orm } from '@kaynooo/pg-orm'

// Using same User and Post entities from above
const userPosts = hasMany('authorId', posts)

// Load all posts by a user
const user = await users.find(1)
const userPostsList = await userPosts.load(user)

console.log(userPostsList.length) // 5

// Count without loading
const postCount = await userPosts.count(user)
console.log(postCount) // 5
```

### hasOne (One-to-One)

Load a single related entity (typically for one-to-one relationships).

```typescript
import { hasOne, orm } from '@kaynooo/pg-orm'

const Profile = orm.entity('profiles', {
  userId: orm.foreignKey('users').unique(),
  bio: orm.string(),
  website: orm.string().nullable(),
}).build()

const profiles = orm.repo(Profile)
const userProfile = hasOne('userId', profiles)

// Load user's profile
const user = await users.find(1)
const profile = await userProfile.load(user)

console.log(profile?.bio) // "Software Developer"
```

## Batch Loading (N+1 Prevention)

All relation loaders support batch loading to prevent N+1 query problems:

### belongsTo Batch Loading

```typescript
// Load all posts
const allPosts = await posts.findAll() // 1 query

// Batch load all unique authors
const postAuthor = belongsTo('authorId', users)
const authorsMap = await postAuthor.loadMany(allPosts) // 1 query

// Access authors efficiently
for (const post of allPosts) {
  const author = authorsMap.get(post.authorId)
  console.log(`${post.title} by ${author?.name}`)
}

// Total: 2 queries instead of N+1
```

### hasMany Batch Loading

```typescript
// Load multiple users
const allUsers = await users.findBy({
  where: { isActive: true }
}) // 1 query

// Batch load all posts for all users
const userPosts = hasMany('authorId', posts)
const postsMap = await userPosts.loadMany(allUsers) // 1 query

// Access posts efficiently
for (const user of allUsers) {
  const posts = postsMap.get(user.id) || []
  console.log(`${user.name} has ${posts.length} posts`)
}

// Total: 2 queries instead of N+1
```

### hasOne Batch Loading

```typescript
// Load multiple users
const allUsers = await users.findAll() // 1 query

// Batch load profiles for all users
const userProfile = hasOne('userId', profiles)
const profilesMap = await userProfile.loadMany(allUsers) // 1 query

// Access profiles efficiently
for (const user of allUsers) {
  const profile = profilesMap.get(user.id)
  console.log(`${user.name}: ${profile?.bio || 'No bio'}`)
}

// Total: 2 queries instead of N+1
```

## Complete Example

Here's a complete example showing all relation types:

```typescript
import { belongsTo, hasMany, hasOne, orm } from '@kaynooo/pg-orm'

// ============================================================================
// Entity Definitions
// ============================================================================

const User = orm.entity('users', {
  name: orm.string(),
  email: orm.string().unique(),
}).build()

const Profile = orm.entity('profiles', {
  userId: orm.foreignKey('users', 'id', {
    onDelete: 'CASCADE'
  }).unique(),
  bio: orm.string(),
  website: orm.string().nullable(),
}).build()

const Post = orm.entity('posts', {
  title: orm.string(),
  content: orm.string(),
  authorId: orm.foreignKey('users', 'id', {
    onDelete: 'CASCADE'
  }),
  published: orm.boolean().default(false),
}).build()

const Comment = orm.entity('comments', {
  postId: orm.foreignKey('posts', 'id', {
    onDelete: 'CASCADE'
  }),
  userId: orm.foreignKey('users', 'id', {
    onDelete: 'SET NULL'
  }).nullable(),
  content: orm.string(),
}).build()

// ============================================================================
// Repositories
// ============================================================================

const users = orm.repo(User)
const profiles = orm.repo(Profile)
const posts = orm.repo(Post)
const comments = orm.repo(Comment)

// ============================================================================
// Relation Definitions
// ============================================================================

// User relations
const userProfile = hasOne('userId', profiles)
const userPosts = hasMany('authorId', posts)
const userComments = hasMany('userId', comments)

// Post relations
const postAuthor = belongsTo('authorId', users)
const postComments = hasMany('postId', comments)

// Comment relations
const commentPost = belongsTo('postId', posts)
const commentAuthor = belongsTo('userId', users)

// ============================================================================
// Usage Examples
// ============================================================================

async function loadUserWithRelations(userId: number) {
  // Load user
  const user = await users.find(userId)
  if (!user) return null

  // Load all related data
  const [profile, userPostsList, userCommentsList] = await Promise.all([
    userProfile.load(user),
    userPosts.load(user),
    userComments.load(user),
  ])

  return {
    user,
    profile,
    posts: userPostsList,
    comments: userCommentsList,
  }
}

async function loadPostWithRelations(postId: number) {
  // Load post
  const post = await posts.find(postId)
  if (!post) return null

  // Load related data
  const [author, postCommentsList] = await Promise.all([
    postAuthor.load(post),
    postComments.load(post),
  ])

  // Load comment authors (batch loading)
  const commentAuthorsMap = await commentAuthor.loadMany(postCommentsList)

  const commentsWithAuthors = postCommentsList.map(comment => ({
    ...comment,
    author: comment.userId ? commentAuthorsMap.get(comment.userId) : null,
  }))

  return {
    post,
    author,
    comments: commentsWithAuthors,
  }
}

async function loadDashboard() {
  // Load active users
  const activeUsers = await users.findBy({
    where: { isActive: true },
    limit: 10,
  })

  // Batch load all relations
  const [profilesMap, postsMap] = await Promise.all([
    userProfile.loadMany(activeUsers),
    userPosts.loadMany(activeUsers),
  ])

  // Combine data
  return activeUsers.map(user => ({
    user,
    profile: profilesMap.get(user.id),
    posts: postsMap.get(user.id) || [],
    postCount: (postsMap.get(user.id) || []).length,
  }))
}

// Run examples
const userDetails = await loadUserWithRelations(1)
const postDetails = await loadPostWithRelations(1)
const dashboard = await loadDashboard()
```

## Best Practices

1. **Use batch loading** - Always use `loadMany()` when loading relations for multiple entities
2. **Define foreign keys** - Use `.foreignKey()` for referential integrity and auto-migrations
3. **Choose appropriate CASCADE options** - Consider data lifecycle when setting `onDelete`/`onUpdate`
4. **Nullable foreign keys** - Use `.nullable()` with `onDelete: 'SET NULL'` for optional relations
5. **Unique constraints** - Add `.unique()` for one-to-one relationships (hasOne)
6. **Count when possible** - Use `hasMany.count()` instead of loading when you only need counts

## Type Safety

All relation loaders are fully type-safe:

```typescript
// TypeScript knows the types
const author: InferEntity<typeof User.schema> | null = await postAuthor.load(post)
const posts: InferEntity<typeof Post.schema>[] = await userPosts.load(user)
const authorsMap: Map<number, InferEntity<typeof User.schema>> = await postAuthor.loadMany(posts)
```

## Migration Support

Foreign keys defined with `.foreignKey()` are automatically detected by the migration system:

```typescript
const Post = orm.entity('posts', {
  authorId: orm.foreignKey('users', 'id', {
    onDelete: 'CASCADE'
  }),
}).build()

// Auto-migration will generate:
// ALTER TABLE posts
//   ADD CONSTRAINT fk_posts_author_id
//   FOREIGN KEY (author_id)
//   REFERENCES users(id)
//   ON DELETE CASCADE
//   ON UPDATE NO ACTION
```

## See Also

- [Pagination Guide](./pagination.md) - Cursor-based pagination for large datasets
- [Query Builder](../README.md#query-builder) - Advanced query patterns
- [Transactions](../README.md#transactions) - Multi-table operations
