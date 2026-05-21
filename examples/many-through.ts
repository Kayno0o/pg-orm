// hasManyThrough smoke check — runnable with: bun run examples/many-through.ts
// Validates M:N relations, nested includes, and relation filtering.
// Requires: docker compose up -d (PG18 on localhost:8532)

import type { InferEntity } from '../src/index'
import { Database, defineTable } from '../src/index'

// 1. Define all tables (columns only)
const _tags = defineTable('mt_tags', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull().unique(),
}))

const postTags = defineTable('mt_post_tags', t => ({
  postId: t.integer().notNull(),
  tagId: t.integer().notNull(),
}))

const _comments = defineTable('mt_comments', t => ({
  id: t.serial().primaryKey(),
  postId: t.integer().notNull(),
  body: t.text().notNull(),
  approved: t.bool().notNull().default(false),
}))

const _posts = defineTable('mt_posts', t => ({
  id: t.serial().primaryKey(),
  title: t.text().notNull(),
}))

// 2. Two-phase: add relations
const tags = _tags
const comments = _comments.withRelations(r => ({
  post: r.belongsTo<InferEntity<typeof _posts>>('mt_posts', 'postId'),
}))
const postsTable = _posts.withRelations(r => ({
  tags: r.hasManyThrough<InferEntity<typeof _tags>>('mt_tags', 'mt_post_tags', { from: 'postId', to: 'tagId' }),
  comments: r.hasMany<InferEntity<typeof _comments>>('mt_comments', 'postId'),
}))

const db = new Database({
  url: 'postgres://test:test@localhost:8532/orm_test',
  tables: [postsTable, tags, postTags, comments],
})

const PostRepo = db.repo(postsTable)
const PostTagRepo = db.repo(postTags)
const TagRepo = db.repo(tags)
const CommentRepo = db.repo(comments)

async function main() {
  // Auto-migrate
  await db.sync({ allowDestructive: true })

  // Clean slate
  await db.raw`DELETE FROM mt_post_tags`
  await db.raw`DELETE FROM mt_comments`
  await db.raw`DELETE FROM mt_posts`
  await db.raw`DELETE FROM mt_tags`

  // Seed data (insertOne now returns the primary key only)
  const p1 = await PostRepo.write.insertOne({ title: 'Post A' })
  const p2 = await PostRepo.write.insertOne({ title: 'Post B' })
  const t1 = await TagRepo.write.insertOne({ name: 'rust' })
  const t2 = await TagRepo.write.insertOne({ name: 'typescript' })
  const t3 = await TagRepo.write.insertOne({ name: 'bun' })

  // Link: Post A → rust, typescript; Post B → typescript, bun
  await PostTagRepo.write.insertMany([
    { postId: p1, tagId: t1 },
    { postId: p1, tagId: t2 },
    { postId: p2, tagId: t2 },
    { postId: p2, tagId: t3 },
  ])

  // Add comments
  await CommentRepo.write.insertMany([
    { postId: p1, body: 'Great post!', approved: true },
    { postId: p1, body: 'Spam', approved: false },
    { postId: p1, body: 'Interesting', approved: true },
    { postId: p2, body: 'Nice!', approved: true },
    { postId: p2, body: 'Meh', approved: false },
  ])

  // --- hasManyThrough ---
  console.log('--- hasManyThrough ---')
  const postsWithTags = await PostRepo.read.findMany(q => q.include('tags'))

  for (const post of postsWithTags) {
    const tagNames = post.tags.map(t => t.name).join(', ')

    console.log(`${post.title}: [${tagNames}]`)
  }

  const postA = postsWithTags.find(p => p.title === 'Post A')
  const postB = postsWithTags.find(p => p.title === 'Post B')
  const aOk = postA?.tags.length === 2 && postA.tags.some(t => t.name === 'rust')
  const bOk = postB?.tags.length === 2 && postB.tags.some(t => t.name === 'bun')

  console.log(`hasManyThrough: ${aOk && bOk ? 'PASS' : 'FAIL'}`)

  // --- NEW: Include with filtering ---
  console.log('\n--- Include with Filtering ---')
  const postsWithApproved = await PostRepo.read.findMany(q =>
    q.include('comments', comments, sq => sq.where(e => e.eq('approved', true))),
  )

  for (const post of postsWithApproved) {
    console.log(`${post.title}: ${post.comments.length} approved comments`)
  }

  const filterOk = postsWithApproved.find(p => p.title === 'Post A')?.comments.length === 2
    && postsWithApproved.find(p => p.title === 'Post B')?.comments.length === 1

  console.log(`Relation filtering: ${filterOk ? 'PASS' : 'FAIL'}`)

  // --- NEW: Nested includes (posts.comments via dotted path) ---
  console.log('\n--- Nested Includes ---')
  const postsNested = await PostRepo.read.findMany(q =>
    q.include('comments'),
  )

  for (const post of postsNested) {
    console.log(`${post.title}: ${post.comments.length} total comments`)
    for (const c of post.comments) {
      console.log(`  - "${c.body}" (approved: ${c.approved})`)
    }
  }

  const nestedOk = postsNested.find(p => p.title === 'Post A')?.comments.length === 3
    && postsNested.find(p => p.title === 'Post B')?.comments.length === 2

  console.log(`Nested includes: ${nestedOk ? 'PASS' : 'FAIL'}`)

  // --- NEW: Multiple includes in parallel ---
  console.log('\n--- Multiple Includes (parallel) ---')
  const postsWithBoth = await PostRepo.read.findMany(q =>
    q.include('tags').include('comments'),
  )

  for (const post of postsWithBoth) {
    const tagNames = post.tags.map(t => t.name).join(', ')

    console.log(`${post.title}: tags=[${tagNames}], comments=${post.comments.length}`)
  }

  const bothOk = postsWithBoth.every(p => p.tags.length > 0 && p.comments.length > 0)

  console.log(`Multiple includes: ${bothOk ? 'PASS' : 'FAIL'}`)

  // --- NEW: Cursor pagination ---
  console.log('\n--- Cursor Pagination ---')
  const page1 = await CommentRepo.read.paginateCursor({ take: 2, column: 'id' })

  console.log(`Page 1: ${page1.data.length} comments (next: ${page1.nextCursor})`)

  if (page1.nextCursor != null) {
    const page2 = await CommentRepo.read.paginateCursor({
      take: 2,
      column: 'id',
      cursor: page1.nextCursor,
    })

    console.log(`Page 2: ${page2.data.length} comments (next: ${page2.nextCursor})`)

    if (page2.nextCursor != null) {
      const page3 = await CommentRepo.read.paginateCursor({
        take: 2,
        column: 'id',
        cursor: page2.nextCursor,
      })

      console.log(`Page 3: ${page3.data.length} comments (next: ${page3.nextCursor})`)
    }
  }

  // Cleanup
  await db.raw`DROP TABLE IF EXISTS mt_post_tags`
  await db.raw`DROP TABLE IF EXISTS mt_comments`
  await db.raw`DROP TABLE IF EXISTS mt_posts`
  await db.raw`DROP TABLE IF EXISTS mt_tags`
  await db.close()
}

await main()
