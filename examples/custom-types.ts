/**
 * Example: Using custom types on fields
 *
 * This example demonstrates how to use TypeScript literal types
 * with various field types to create type-safe values at the type level.
 */

import { ORM } from '../src'

const orm = new ORM()

// Define an entity with various custom types
const Application = orm.entity('applications', f => ({
  name: f.string(),

  // Custom string types - union of literal strings
  type: f.string<'app' | 'service' | 'library'>(),
  environment: f.string<'dev' | 'staging' | 'prod'>().nullable(),
  status: f.string<'active' | 'inactive'>().default('active'),

  // Custom number types - union of literal numbers
  priority: f.number<1 | 2 | 3>().default(2),
  severity: f.number<0 | 1 | 2 | 3 | 4 | 5>().nullable(),

  // Custom boolean types - literal true or false
  requiresAuth: f.boolean<true>().default(true),
  isPublic: f.boolean<false>(),
})).build()

async function main() {
  await orm.connect(process.env.DATABASE_URL!)
  const apps = orm.repo(Application)

  console.log('=== Creating application with custom types ===\n')

  // TypeScript will enforce all custom types
  const app = await apps.create({
    name: 'My App',
    type: 'app', // ✅ Must be 'app' | 'service' | 'library'
    environment: 'prod', // ✅ Must be 'dev' | 'staging' | 'prod' | null
    priority: 1, // ✅ Must be 1 | 2 | 3
    severity: 3, // ✅ Must be 0-5 or null
    isPublic: false, // ✅ Must be false (literal type)
    // status defaults to 'active'
    // requiresAuth defaults to true
    // versionId is auto-generated
  })

  console.log('Created:', app)
  console.log('Type:', app.type) // Type is 'app' | 'service' | 'library'
  console.log('Priority:', app.priority) // Type is 1 | 2 | 3
  console.log('RequiresAuth:', app.requiresAuth) // Type is true
  console.log('IsPublic:', app.isPublic) // Type is false

  // TypeScript will catch invalid values at compile time
  // await apps.create({
  //   name: 'Invalid',
  //   type: 'invalid', // ❌ Error: not assignable to 'app' | 'service' | 'library'
  //   priority: 5, // ❌ Error: not assignable to 1 | 2 | 3
  //   isPublic: true, // ❌ Error: not assignable to false
  // })

  console.log('\n=== Updating with type-safe values ===\n')

  const updated = await apps.update(app.id, {
    priority: 3, // ✅ Must be 1 | 2 | 3
    environment: 'staging', // ✅ Must be 'dev' | 'staging' | 'prod'
  })

  console.log('Updated priority:', updated.priority)
  console.log('Updated environment:', updated.environment)

  console.log('\n=== Querying with custom types ===\n')

  // Create a few more apps
  await apps.create({ name: 'Service A', type: 'service', priority: 2, isPublic: false })
  await apps.create({ name: 'Library B', type: 'library', priority: 1, isPublic: false })

  // Query by custom type
  const services = await apps.query()
    .where('type', '=', 'service')
    .execute()

  console.log(`Found ${services.length} service(s)`)

  // Query by priority
  const highPriority = await apps.query()
    .where('priority', '=', 3)
    .execute()

  console.log(`Found ${highPriority.length} high priority app(s)`)

  await orm.disconnect()
}

// eslint-disable-next-line github/no-then
main().catch(console.error)
