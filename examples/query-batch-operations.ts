import { orm } from '../src'

const User = orm.entity('users', {
  name: orm.string(),
  email: orm.string().unique(),
  status: orm.enum(['active', 'inactive', 'suspended'] as const),
  age: orm.number().nullable(),
}).build()

async function main() {
  await orm.connect(process.env.DATABASE_URL!)
  const users = orm.repo(User)

  console.log('=== Phase 1: Batch Update Operations ===\n')

  await users.create({ name: 'Alice', email: 'alice@example.com', status: 'inactive', age: 25 })
  await users.create({ name: 'Bob', email: 'bob@example.com', status: 'inactive', age: 30 })
  await users.create({ name: 'Charlie', email: 'charlie@example.com', status: 'active', age: 35 })

  const affectedRows = await users.query()
    .where('status', '=', 'inactive')
    .update({ status: 'active' })

  console.log(`Updated ${affectedRows} users from inactive to active`)

  const allActive = await users.query()
    .where('status', '=', 'active')
    .execute()

  console.log(`Now ${allActive.length} users are active\n`)

  console.log('=== Phase 2: Batch Delete Operations ===\n')

  await users.create({ name: 'Dave', email: 'dave@example.com', status: 'suspended', age: 40 })
  await users.create({ name: 'Eve', email: 'eve@example.com', status: 'suspended', age: 45 })

  const deletedRows = await users.query()
    .where('status', '=', 'suspended')
    .deleteMany()

  console.log(`Deleted ${deletedRows} suspended users`)

  const remaining = await users.query().execute()

  console.log(`${remaining.length} users remaining\n`)

  console.log('=== Phase 3: Pagination ===\n')

  for (let i = 1; i <= 25; i++) {
    await users.create({
      name: `User ${i}`,
      email: `user${i}@example.com`,
      status: 'active',
      age: 20 + (i % 30),
    })
  }

  const page1 = await users.query()
    .where('status', '=', 'active')
    .orderBy('name', 'ASC')
    .paginate({ page: 1, limit: 10 })

  console.log(`Page 1: ${page1.data.length} users`)
  console.log(`Total: ${page1.meta.total} users`)
  console.log(`Total pages: ${page1.meta.totalPages}`)
  console.log(`First user: ${page1.data[0]?.name}`)
  console.log(`Last user: ${page1.data[page1.data.length - 1]?.name}\n`)

  const page2 = await users.query()
    .where('status', '=', 'active')
    .orderBy('name', 'ASC')
    .paginate({ page: 2, limit: 10 })

  console.log(`Page 2: ${page2.data.length} users`)
  console.log(`First user: ${page2.data[0]?.name}`)
  console.log(`Last user: ${page2.data[page2.data.length - 1]?.name}\n`)

  await orm.disconnect()
}

// eslint-disable-next-line github/no-then
main().catch(console.error)
