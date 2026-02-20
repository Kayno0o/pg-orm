// Quickstart — runnable with: bun run examples/quickstart.ts
// Requires: docker compose up -d (PG18 on localhost:8532)

import type { InferEntity, InferInsert } from '../src/index'
import { Database, defineTable } from '../src/index'

// 1. Define tables (columns only — no circular refs)
const _users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  email: t.varchar(255).notNull().unique(),
  deletedAt: t.timestamptz().nullable(),
  createdAt: t.timestamptz().notNull().default('now()'),
}))

const _posts = defineTable('posts', t => ({
  id: t.serial().primaryKey(),
  title: t.text().notNull(),
  body: t.text().notNull(),
  authorId: t.integer().notNull(),
  createdAt: t.timestamptz().notNull().default('now()'),
}))

// 2. Two-phase: add relations after both tables exist — fully typed via InferEntity
const users = _users.withRelations(r => ({
  posts: r.hasMany<InferEntity<typeof _posts>>('posts', 'authorId'),
}))

const posts = _posts.withRelations(r => ({
  author: r.belongsTo<InferEntity<typeof _users>>('users', 'authorId'),
}))

// 3. Database — connection pool + table registry
const db = new Database({
  url: 'postgres://test:test@localhost:8532/orm_test',
  pool: { max: 5 },
  tables: [users, posts],
})

// 4. InferSelect / InferInsert — explicit type usage
type NewUser = InferInsert<typeof users.columns>

// 5. Hook registration — normalise email before insert
users.hook('beforeInsert', (row: NewUser) => ({
  ...row,
  email: row.email.toLowerCase(),
}))

// 6. Repos from db.repo()
const UserRepo = db.repo(users)
const PostRepo = db.repo(posts)

async function main() {
  // Auto-migrate (creates tables if missing)
  await db.sync({ allowDestructive: true })

  // Clean slate
  await db.raw`DELETE FROM posts`
  await db.raw`DELETE FROM users`

  // 7. Basic CRUD — insert
  const alice = await UserRepo.insertOne({ name: 'Alice', email: 'ALICE@example.com' })

  console.log('Inserted:', alice.id, alice.email) // email lowercased by hook

  const bob = await UserRepo.insertOne({ name: 'Bob', email: 'bob@example.com' })

  // insert many posts
  const insertedPosts = await PostRepo.insertMany([
    { title: 'Hello', body: 'First post', authorId: alice.id },
    { title: 'World', body: 'Second post', authorId: alice.id },
    { title: 'Bob post', body: 'Third post', authorId: bob.id },
  ])

  console.log('Inserted posts:', insertedPosts.length)

  // findOne — callback style
  const found = await UserRepo.findOne(q => q.where(e => e.eq('id', alice.id)))

  console.log('Found user:', found?.name)

  // findMany — no args returns all
  const allUsers = await UserRepo.findMany()

  console.log('All users:', allUsers.length)

  // update
  const updated = await UserRepo.updateMany(
    { name: 'Alice Updated' },
    e => e.eq('id', alice.id),
  )

  console.log('Updated:', updated[0]?.name)

  // 8. Expression builder — .where() with e.and() / e.or()
  const filtered = await PostRepo.findMany(q =>
    q.where(e =>
      e.or(
        e.eq('authorId', alice.id),
        e.and(e.eq('authorId', bob.id), e.like('title', 'Bob%')),
      ),
    ),
  )

  console.log('Filtered posts:', filtered.length)

  // 9. Join query
  const joined = await PostRepo.findMany(q =>
    q.join('users', 'u', e => e.raw('"u"."id" = "posts"."authorId"'))
      .where(e => e.eq('authorId', alice.id)),
  )

  console.log('Joined posts:', joined.length)

  // 10. .include() eager load — typed! 'posts' autocompletes from relation names
  const usersWithPosts = await UserRepo.findMany(q => q.include('posts'))

  for (const u of usersWithPosts) {
    console.log(`${u.name}: ${u.posts.length} posts`) // u.posts is typed as Post[]
  }

  // belongsTo include — author is typed as User | null
  const postsWithAuthor = await PostRepo.findMany(q => q.include('author'))

  for (const p of postsWithAuthor) {
    console.log(`${p.title} by ${p.author?.name}`) // p.author is typed as User | null
  }

  // 11. Transaction with savepoint
  await db.transaction(async (tx) => {
    const txRepo = UserRepo.using(tx)

    await txRepo.insertOne({ name: 'Charlie', email: 'charlie@example.com' })

    // Savepoint — rollback nested operation
    try {
      await tx.savepoint(async () => {
        await txRepo.insertOne({ name: 'DupeCharlie', email: 'charlie@example.com' })
      })
    }
    catch {
      console.log('Savepoint rolled back (expected — duplicate email)')
    }
  })

  // 12. Streaming — async iterator (callback style)
  let streamCount = 0

  for await (const _post of PostRepo.stream(q => q, { chunkSize: 2 })) {
    streamCount++
  }

  console.log('Streamed posts:', streamCount)

  // 13. Raw SQL — tagged template
  const rawResult = await db.raw<{ count: string }>`SELECT count(*) FROM users`

  console.log('Total users:', rawResult[0]?.count)

  // delete
  const deleted = await UserRepo.deleteMany(e => e.eq('name', 'Charlie'))

  console.log('Deleted:', deleted.length)

  // Cleanup
  await db.raw`DROP TABLE IF EXISTS posts`
  await db.raw`DROP TABLE IF EXISTS users`
  await db.close()
}

await main()
