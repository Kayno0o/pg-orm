import { orm, publishable, softDelete, timestamps } from './src'

// ============================================================================
// 1. Define Entities with Builder Pattern
// ============================================================================

// Define typed metadata for better type safety
interface UserMetadata {
  preferences: Record<string, string>
  settings?: {
    theme: 'light' | 'dark'
    notifications: boolean
  }
}

// ============================================================================
// 2. Custom Trait Example (NEW!)
// ============================================================================

// Custom trait with builder pattern and repository access
const likeable = orm.trait()
  .field('likesCount', orm.number().integer().default(0))
  .field('likedBy', orm.array('number').default([]))
  .method('like', async function (repo, userId: number) {
    // 'this' is the entity, 'repo' has full database access
    if (!this.likedBy.includes(userId)) {
      return repo.update(this.id, {
        likesCount: this.likesCount + 1,
        likedBy: [...this.likedBy, userId],
      })
    }

    return this
  })
  .method('unlike', async function (repo, userId: number) {
    if (this.likedBy.includes(userId)) {
      return repo.update(this.id, {
        likesCount: this.likesCount - 1,
        likedBy: this.likedBy.filter((id: number) => id !== userId),
      })
    }

    return this
  })
  .method('isLikedBy', function (_repo, userId: number): boolean {
    return this.likedBy.includes(userId)
  })
  .build()

// Simple entity definition with improved type safety
const User = orm
  .entity('users', {
    name: orm.string(), // Required by default (no undefined in type)
    email: orm.string().unique(), // Required, unique constraint
    age: orm.number().nullable(), // Optional (can be null or undefined in create)
    role: orm.enum(['admin', 'user', 'moderator'] as const), // Required enum
    isActive: orm.boolean().default(true), // Optional (has default)
    metadata: orm.jsonb<UserMetadata>().nullable(), // Typed JSON, optional
    tags: orm.array('string'), // Typed string array, required
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

// Another entity with different traits including custom trait
const Post = orm
  .entity('posts', {
    title: orm.string().maxLength(255),
    content: orm.string(),
    authorId: orm.number(),
    views: orm.number().integer().default(0),
  })
  .use(timestamps())
  .use(publishable())
  .use(likeable) // Custom trait with repository access!
  .use(softDelete()) // Soft delete trait
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
  // Connect to database with migration configuration
  await orm.connect({
    connectionString: process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/orm_test',
    migrations: {
      autoMigrate: true, // Prompt for schema changes (default: true)
      noInteraction: true, // Auto-approve in this example (default: false)
      migrationsPath: 'migrations', // Custom path for migration files
      safeMigrations: true, // Never auto-drop columns (default: true)
    },
  })

  // Tables will be created automatically by auto-migration system!
  // The migration system detects entity definitions and creates tables as needed

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
    return this.query().where('authorId', '=', authorId).execute()
  },

  async findPublished(this) {
    return this.query().where('published', '=', true).orderBy('publishedAt', 'DESC').execute()
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

  // Create - Demonstrates improved type safety:
  // - name, email, role, tags are REQUIRED (TypeScript enforces this)
  // - age, metadata are OPTIONAL (can be omitted)
  // - isActive is OPTIONAL (has default value)
  const user = await users.create({
    name: 'John Doe',
    email: 'JOHN@EXAMPLE.COM', // Will be lowercased by beforeCreate hook
    role: 'admin',
    tags: ['developer', 'admin'],
    // age is optional - we can omit it
    // metadata is optional - we can omit it
    // isActive will use default value (true)
  })

  console.log('Created user:', user)

  // Create with typed metadata - autocomplete and type checking work!
  const userWithMetadata = await users.create({
    name: 'Jane Doe',
    email: 'jane@example.com',
    role: 'user',
    tags: ['frontend'],
    metadata: {
      preferences: { language: 'en', timezone: 'UTC' },
      settings: {
        theme: 'dark', // TypeScript knows valid values!
        notifications: true,
      },
    },
  })

  console.log('Created user with metadata:', userWithMetadata)

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
  const admins = await users.query()
    .where('role', '=', 'admin')
    .orderBy('name', 'ASC')
    .execute()

  console.log('Admins:', admins)

  // Find one
  const alice = await users.query()
    .where('email', '=', 'alice@example.com')
    .findOne()

  console.log('Alice:', alice)

  // Count
  const count = await users.query()
    .where('role', '=', 'admin')
    .count()

  console.log('Admin count:', count)

  // Complex where conditions with query builder
  const adults = await users.query()
    .where('age', '>=', 18)
    .whereIn('role', ['admin', 'moderator'])
    .execute()

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
  const authorPosts = await posts.findByAuthor(author.id) as any[]

  console.log('Author posts:', authorPosts)

  const published = await posts.findPublished() as any[]

  console.log('Published posts:', published)

  // Increment views
  const post = authorPosts[0] ? await posts.incrementViews(authorPosts[0].id) : null

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
// 10. Trait Methods with Repository Context (NEW!)
// ============================================================================

async function traitMethodsDemo() {
  console.log('\n=== Trait Methods with Repository Context ===')

  // Create a post
  const author = await users.create({
    name: 'Post Author',
    email: 'postauthor@example.com',
    role: 'user',
    tags: [],
  })

  let post = await posts.create({
    title: 'Likeable Post',
    content: 'This post can be liked!',
    authorId: author.id,
  })

  console.log('Initial likes:', post.likesCount)

  // Use trait methods - they now have full repository access!
  // TypeScript properly infers all trait methods thanks to the type system!
  post = await post.like(1) // User 1 likes the post
  console.log('After first like:', post.likesCount, post.likedBy)

  post = await post.like(2) // User 2 likes the post
  console.log('After second like:', post.likesCount, post.likedBy)

  post = await post.like(1) // User 1 tries to like again (should be ignored)
  console.log('After duplicate like:', post.likesCount, post.likedBy)

  post = await post.unlike(1) // User 1 unlikes
  console.log('After unlike:', post.likesCount, post.likedBy)

  // Check if user liked the post
  console.log('Is liked by user 2?', post.isLikedBy(2))
  console.log('Is liked by user 1?', post.isLikedBy(1))

  // Demonstrate publishable trait methods
  post = await post.publish()
  console.log('Post published:', post.published, post.publishedAt)

  console.log('Is published?', post.isPublished())
  console.log('Is draft?', post.isDraft())

  post = await post.unpublish()
  console.log('Post unpublished:', post.published, post.publishedAt)

  // Demonstrate soft delete trait methods
  post = await post.softDelete()
  console.log('Post soft deleted:', post.deletedAt)
  console.log('Is deleted?', post.isDeleted())

  post = await post.restore()
  console.log('Post restored:', post.deletedAt)
  console.log('Is deleted?', post.isDeleted())
}

// ============================================================================
// 11. Migration System Demo
// ============================================================================

async function migrationDemo() {
  console.log('\n=== Migration System ===')

  // The migration system has already run during orm.connect()
  // It automatically detected the User and Post entity definitions
  // and created the tables if they didn't exist

  console.log('✅ Auto-migration completed during connect()')

  // 1. Check migration status
  console.log('\n1. Migration Status:')
  await orm.migration.status()

  // 2. Demo Migration File Creation (only runs once)
  // This demonstrates two different approaches to migrations:
  // - .create(): Creates an empty migration template for manual SQL
  // - .generate(): Auto-generates migration from schema changes
  // Choose ONE approach based on your workflow!

  await demoMigrationCreation()

  // 3. Run pending migrations (if any were created)
  console.log('\n3. Running pending migrations:')

  try {
    await orm.migration.run()
  }
  catch (error) {
    console.log('   No pending migrations to run')
  }

  // 5. Demonstrate rollback (commented out to not affect the example)
  // console.log('\n5. Rollback last batch:')
  // await orm.migration.rollback()

  // 6. Demonstrate reset (commented out to not affect the example)
  // console.log('\n6. Reset all migrations:')
  // await orm.migration.reset()

  console.log('\n✅ Migration system is fully functional!')
  console.log('\nMigration Features:')
  console.log('  • Auto-migration: Detects schema changes automatically')
  console.log('  • Manual migrations: Create timestamped migration files')
  console.log('  • Schema diffing: Compares entities with database schema')
  console.log('  • Batch tracking: Track and rollback migrations in batches')
  console.log('  • Safe mode: Prevents accidental column drops by default')
}

// ============================================================================
// Migration Creation Helper (with restart safety)
// ============================================================================

async function demoMigrationCreation() {
  const { existsSync } = await import('node:fs')
  const { readdir } = await import('node:fs/promises')

  // Check if migrations folder exists and has files
  const hasMigrationFiles = existsSync('migrations') && (await readdir('migrations')).length > 0

  if (hasMigrationFiles) {
    console.log('\n2. Migration files already exist. Skipping creation demo.')
    console.log('   (Delete the migrations/ folder to see the creation demo again)')

    return
  }

  console.log('\n2. Creating migration files (first run only):')
  console.log('\n   📝 Approach 1 - Manual Migration (.create()):')
  console.log('   Creates an empty template for you to write custom SQL')

  try {
    const filePath = await orm.migration.create('add_user_preferences')

    console.log(`   ✅ Created: ${filePath}`)
    console.log('      Edit this file to add your custom up() and down() logic')
  }
  catch (error) {
    console.log(`   ⚠️  Skipped: ${error instanceof Error ? error.message : 'Already exists'}`)
  }

  console.log('\n   📝 Approach 2 - Auto-Generated Migration (.generate()):')
  console.log('   Detects schema changes and generates SQL automatically')

  try {
    const migrationPath = await orm.migration.generate('auto_schema_update')

    if (migrationPath) {
      console.log(`   ✅ Generated: ${migrationPath}`)
      console.log('      SQL was auto-generated from entity definitions')
    }
    else {
      console.log('   ✅ No schema changes detected')
    }
  }
  catch (error) {
    console.log(`   ⚠️  Skipped: ${error instanceof Error ? error.message : 'Already exists'}`)
  }

  console.log('\n   💡 Tip: Choose ONE approach for your project:')
  console.log('      • Use .create() for full control with manual SQL')
  console.log('      • Use .generate() for automatic schema synchronization')
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  try {
    await setup()
    await migrationDemo()
    await basicCRUD()
    await queryOperations()
    await queryBuilder()
    await customRepositoryMethods()
    await transactions()
    await lifecycleHooks()
    await traitMethodsDemo()

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
    await db`DROP TABLE IF EXISTS _migrations`
    await orm.disconnect()
    console.log('\n🧹 Cleanup complete')
  }
}

main()
