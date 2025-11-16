import { orm, timestamps } from './src'

// ============================================================================
// 1. Define Entities with Builder Pattern
// ============================================================================

// Simple entity definition
const User = orm
  .entity('users', {
    name: orm.string(),
    email: orm.string().unique(),
    age: orm.number().nullable(),
    role: orm.enum(['admin', 'user', 'moderator']),
    isActive: orm.boolean().default(true),
    metadata: orm.jsonb<{ preferences: Record<string, string> }>().nullable(),
    tags: orm.array('string'),
  })
  .use(timestamps()) // Add createdAt and updatedAt
  .beforeCreate((data) => {
    // Normalize email before creation
    data.email &&= data.email.toLowerCase()
  })
  .afterCreate(async (entity) => {
    console.log(`User created: ${entity.name} (${entity.email})`)
  })
  .build()

// Another entity with different traits
const Post = orm
  .entity('posts', {
    title: orm.string().maxLength(255),
    content: orm.string(),
    authorId: orm.number(),
    published: orm.boolean().default(false),
    publishedAt: orm.timestamp().nullable(),
    views: orm.number().integer().default(0),
  })
  .use(timestamps())
  .unique(['title']) // Add unique constraint
  .beforeUpdate((id, data) => {
    // Update publishedAt when published changes to true
    if (data.published === true && !data.publishedAt) {
      data.publishedAt = new Date()
    }
  })
  .build()

// ============================================================================
// 2. Setup Database Connection
// ============================================================================

async function setup() {
  // Connect to database
  await orm.connect(process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/orm_test')

  // Create tables (you would normally use migrations for this)
  const db = orm.getDB()

  await db`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      age INTEGER,
      role TEXT NOT NULL,
      is_active BOOLEAN DEFAULT true,
      metadata JSONB,
      tags TEXT[],
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `

  await db`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      published BOOLEAN DEFAULT false,
      published_at TIMESTAMP WITH TIME ZONE,
      views INTEGER DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `

  console.log('✅ Database setup complete')
}

// ============================================================================
// 3. Create Repositories
// ============================================================================

// Auto-generated repository
const users = orm.repo(User)

// Extended repository with custom methods
const posts = orm.repo(Post).extend({
  async findByAuthor(this, authorId: number) {
    return this.findBy({ where: { authorId } })
  },

  async findPublished(this) {
    return this.findBy({ where: { published: true }, order: { publishedAt: 'DESC' } })
  },

  async incrementViews(this, id: number) {
    const post = await this.find(id)

    if (post) {
      return this.update(id, { views: post.views + 1 })
    }

    return null
  },
})

// ============================================================================
// 4. Basic CRUD Operations
// ============================================================================

async function basicCRUD() {
  console.log('\n=== Basic CRUD ===')

  // Create
  const user = await users.create({
    name: 'John Doe',
    email: 'JOHN@EXAMPLE.COM', // Will be lowercased by beforeCreate hook
    role: 'admin',
    tags: ['developer', 'admin'],
  })

  console.log('Created user:', user)

  // Read
  const foundUser = await users.find(user.id)

  console.log('Found user:', foundUser)

  // Update
  const updatedUser = await users.update(user.id, { age: 30 })

  console.log('Updated user:', updatedUser)

  // Delete
  await users.delete(user.id)
  console.log('Deleted user')
}

// ============================================================================
// 5. Query Operations
// ============================================================================

async function queryOperations() {
  console.log('\n=== Query Operations ===')

  // Create test data
  await users.createMany([
    { name: 'Alice', email: 'alice@example.com', age: 25, role: 'user', tags: ['frontend'] },
    { name: 'Bob', email: 'bob@example.com', age: 30, role: 'moderator', tags: ['backend'] },
    { name: 'Charlie', email: 'charlie@example.com', age: 35, role: 'admin', tags: ['devops', 'admin'] },
  ])

  // Find by conditions
  const admins = await users.findBy({
    where: { role: 'admin' },
    order: { name: 'ASC' },
  })

  console.log('Admins:', admins)

  // Find one
  const alice = await users.findOneBy({
    where: { email: 'alice@example.com' },
  })

  console.log('Alice:', alice)

  // Count
  const count = await users.count({ where: { role: 'admin' } })

  console.log('Admin count:', count)

  // Pagination
  const page = await users.paginate({
    page: 1,
    pageSize: 2,
    order: { name: 'ASC' },
  })

  console.log('Page 1:', page)

  // Complex where conditions
  const adults = await users.findBy({
    where: {
      age: { gte: 18 },
      role: { in: ['admin', 'moderator'] },
    },
  })

  console.log('Adult admins/moderators:', adults)
}

// ============================================================================
// 6. Query Builder
// ============================================================================

async function queryBuilder() {
  console.log('\n=== Query Builder ===')

  // Fluent query building
  const results = await users
    .query()
    .where('age', '>=', 25)
    .whereIn('role', ['admin', 'moderator'])
    .orderBy('name', 'ASC')
    .limit(10)
    .execute()

  console.log('Query builder results:', results)

  // Advanced queries
  const latest = await users.query().latest('createdAt')

  console.log('Latest user:', latest)

  const random = await users.query().random(2)

  console.log('Random users:', random)
}

// ============================================================================
// 7. Custom Repository Methods
// ============================================================================

async function customRepositoryMethods() {
  console.log('\n=== Custom Repository Methods ===')

  // Create some posts
  const author = await users.create({
    name: 'Author',
    email: 'author@example.com',
    role: 'user',
    tags: [],
  })

  await posts.createMany([
    {
      title: 'First Post',
      content: 'Content 1',
      authorId: author.id,
      published: true,
      publishedAt: new Date(),
    },
    { title: 'Second Post', content: 'Content 2', authorId: author.id, published: false },
  ])

  // Use custom method
  const authorPosts = await posts.findByAuthor(author.id)

  console.log('Author posts:', authorPosts)

  const published = await posts.findPublished()

  console.log('Published posts:', published)

  // Increment views
  const post = await posts.incrementViews(authorPosts[0].id)

  console.log('Post with incremented views:', post)
}

// ============================================================================
// 8. Transactions
// ============================================================================

async function transactions() {
  console.log('\n=== Transactions ===')

  try {
    // Repository-scoped transaction
    await users.transaction(async (txUsers) => {
      const user1 = await txUsers.create({
        name: 'TX User 1',
        email: 'tx1@example.com',
        role: 'user',
        tags: [],
      })

      const user2 = await txUsers.create({
        name: 'TX User 2',
        email: 'tx2@example.com',
        role: 'user',
        tags: [],
      })

      console.log('Created users in transaction:', user1, user2)

      // If we throw here, both creates will be rolled back
      // throw new Error('Rollback!')
    })

    // Global transaction with multiple repositories
    await orm.transaction(async (tx) => {
      const txUsers = users.withTransaction(tx)
      const txPosts = posts.withTransaction(tx)

      const author = await txUsers.create({
        name: 'TX Author',
        email: 'txauthor@example.com',
        role: 'user',
        tags: [],
      })

      await txPosts.create({
        title: 'TX Post',
        content: 'Created in transaction',
        authorId: author.id,
      })
    })

    console.log('Transaction completed successfully')
  }
  catch (error) {
    console.error('Transaction failed:', error)
  }
}

// ============================================================================
// 9. Lifecycle Hooks
// ============================================================================

async function lifecycleHooks() {
  console.log('\n=== Lifecycle Hooks ===')

  // Hooks are already defined on the entity
  // beforeCreate hook will lowercase the email
  const user = await users.create({
    name: 'Hook Test',
    email: 'UPPERCASE@EXAMPLE.COM',
    role: 'user',
    tags: [],
  })

  console.log('Email was lowercased:', user.email) // Should be: uppercase@example.com
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  try {
    await setup()
    await basicCRUD()
    await queryOperations()
    await queryBuilder()
    await customRepositoryMethods()
    await transactions()
    await lifecycleHooks()

    console.log('\n✅ All examples completed successfully!')
  }
  catch (error) {
    console.error('❌ Error:', error)
  }
  finally {
    // Cleanup
    const db = orm.getDB()

    await db`DROP TABLE IF EXISTS posts`
    await db`DROP TABLE IF EXISTS users`
    await orm.disconnect()
    console.log('\n🧹 Cleanup complete')
  }
}

main()
