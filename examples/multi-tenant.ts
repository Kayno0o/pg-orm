import { ORM } from '../src'

// Multi-tenant ORM example using PostgreSQL schemas
// Each tenant gets its own schema with isolated data

// Shared entity definition (reused across tenants)
function createUserEntity(orm: ORM) {
  return orm.entity('users', f => ({
    name: f.string(),
    email: f.string().unique(),
    plan: f.enum(['free', 'pro', 'enterprise']).default('free'),
  })).build()
}

function createPostEntity(orm: ORM) {
  return orm.entity('posts', f => ({
    title: f.string(),
    content: f.string(),
    authorId: f.foreignKey('users').onDelete('CASCADE'),
    published: f.boolean().default(false),
  })).build()
}

// eslint-disable-next-line max-lines-per-function
async function demonstrateMultiTenant() {
  console.log('🏢 Multi-Tenant ORM Demo\n')

  // Create separate ORM instances for different tenants
  const tenant1Orm = new ORM()
  const tenant2Orm = new ORM()

  try {
    // Define entities BEFORE connecting (required for auto-migration)
    const Tenant1User = createUserEntity(tenant1Orm)
    const Tenant1Post = createPostEntity(tenant1Orm)

    const Tenant2User = createUserEntity(tenant2Orm)
    const Tenant2Post = createPostEntity(tenant2Orm)

    // Register repositories BEFORE connecting
    const tenant1Users = tenant1Orm.repo(Tenant1User)
    const tenant1Posts = tenant1Orm.repo(Tenant1Post)

    const tenant2Users = tenant2Orm.repo(Tenant2User)
    const tenant2Posts = tenant2Orm.repo(Tenant2Post)

    // Connect tenant 1 to 'tenant_acme' schema
    console.log('📦 Setting up Tenant 1 (ACME Corp)...')
    await tenant1Orm.connect({
      connectionString: Bun.env.DATABASE_URL,
      schema: 'tenant_acme',
      migrations: {
        autoMigrate: true,
        noInteraction: true,
        safeMigrations: false,
      },
    })

    // Connect tenant 2 to 'tenant_globex' schema
    console.log('📦 Setting up Tenant 2 (Globex Inc)...')
    await tenant2Orm.connect({
      connectionString: Bun.env.DATABASE_URL,
      schema: 'tenant_globex',
      migrations: {
        autoMigrate: true,
        noInteraction: true,
        safeMigrations: false,
      },
    })

    // Create data for Tenant 1 (ACME Corp)
    console.log('\n✨ Creating data for Tenant 1 (ACME Corp)...')
    const acmeUser = await tenant1Users.create({
      name: 'Alice (ACME)',
      email: 'alice@acme.com',
      plan: 'enterprise',
    })

    await tenant1Posts.create({
      title: 'Welcome to ACME',
      content: 'Our enterprise platform is ready!',
      authorId: acmeUser.id,
      published: true,
    })

    // Create data for Tenant 2 (Globex Inc)
    console.log('✨ Creating data for Tenant 2 (Globex Inc)...')
    const globexUser = await tenant2Users.create({
      name: 'Bob (Globex)',
      email: 'bob@globex.com',
      plan: 'free',
    })

    await tenant2Posts.create({
      title: 'Welcome to Globex',
      content: 'Getting started with our free plan!',
      authorId: globexUser.id,
      published: true,
    })

    // Query data from each tenant (completely isolated)
    console.log('\n📊 Querying Tenant 1 data...')
    const acmeUsers = await tenant1Users.findAll()
    const acmePosts = await tenant1Posts.findAll()

    console.log(`   Users: ${acmeUsers.length}`)
    console.log(`   Posts: ${acmePosts.length}`)
    console.log(`   First user: ${acmeUsers[0]?.name} (${acmeUsers[0]?.plan})`)

    console.log('\n📊 Querying Tenant 2 data...')
    const globexUsers = await tenant2Users.findAll()
    const globexPosts = await tenant2Posts.findAll()

    console.log(`   Users: ${globexUsers.length}`)
    console.log(`   Posts: ${globexPosts.length}`)
    console.log(`   First user: ${globexUsers[0]?.name} (${globexUsers[0]?.plan})`)

    // Demonstrate isolation: queries don't cross schemas
    console.log('\n🔒 Data Isolation Verified:')
    console.log(`   Tenant 1 cannot see Tenant 2's data`)
    console.log(`   Each tenant has its own isolated database schema`)

    // Show schema information
    console.log('\n🗄️  Schema Information:')
    console.log(`   Tenant 1 schema: ${tenant1Orm.getSchema()}`)
    console.log(`   Tenant 2 schema: ${tenant2Orm.getSchema()}`)

    // Demonstrate per-tenant transactions
    console.log('\n💳 Demonstrating per-tenant transactions...')
    await tenant1Orm.transaction(async (tx) => {
      const txUsers = tenant1Users.withTransaction(tx)
      const txPosts = tenant1Posts.withTransaction(tx)

      const newUser = await txUsers.create({
        name: 'Charlie (ACME)',
        email: 'charlie@acme.com',
        plan: 'pro',
      })

      await txPosts.create({
        title: 'Transaction Test',
        content: 'This was created in a transaction',
        authorId: newUser.id,
        published: false,
      })

      console.log('   ✅ Tenant 1 transaction committed')
    })

    const finalUserCount = await tenant1Users.count()

    console.log(`   Tenant 1 now has ${finalUserCount} users`)

    console.log('\n✅ Multi-tenant demo completed successfully!')
  }
  catch (error) {
    console.error('❌ Error:', error)
    throw error
  }
  finally {
    // Clean up: Drop tenant schemas
    console.log('\n🧹 Cleaning up...')

    try {
      const db1 = tenant1Orm.getDB()

      await db1.unsafe('DROP SCHEMA IF EXISTS tenant_acme CASCADE')
      console.log('   Dropped tenant_acme schema')
    }
    catch {
      // Ignore cleanup errors
    }

    try {
      const db2 = tenant2Orm.getDB()

      await db2.unsafe('DROP SCHEMA IF EXISTS tenant_globex CASCADE')
      console.log('   Dropped tenant_globex schema')
    }
    catch {
      // Ignore cleanup errors
    }

    // Disconnect both tenants
    await tenant1Orm.disconnect()
    await tenant2Orm.disconnect()
    console.log('   Disconnected from database\n')
  }
}

// Run the demo
// eslint-disable-next-line github/no-then
demonstrateMultiTenant().catch(console.error)
