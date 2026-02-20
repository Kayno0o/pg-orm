// hasManyThrough smoke check — runnable with: bun run examples/many-through.ts
// Validates the join resolution path for M:N relations end-to-end.
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

const _posts = defineTable('mt_posts', t => ({
  id: t.serial().primaryKey(),
  title: t.text().notNull(),
}))

// 2. Two-phase: add relations — InferEntity<typeof _tags> gives full type safety
const tags = _tags
const postsTable = _posts.withRelations(r => ({
  tags: r.hasManyThrough<InferEntity<typeof _tags>>('mt_tags', 'mt_post_tags', { from: 'postId', to: 'tagId' }),
}))

const db = new Database({
  url: 'postgres://test:test@localhost:8532/orm_test',
  tables: [postsTable, tags, postTags],
})

const PostRepo = db.repo(postsTable)

async function main() {
  // Auto-migrate
  await db.sync({ allowDestructive: true })

  // Clean slate
  await db.raw`DELETE FROM mt_post_tags`
  await db.raw`DELETE FROM mt_posts`
  await db.raw`DELETE FROM mt_tags`

  // Seed data
  const [p1] = await db.raw<{ id: number }>`INSERT INTO mt_posts (title) VALUES ('Post A') RETURNING id`
  const [p2] = await db.raw<{ id: number }>`INSERT INTO mt_posts (title) VALUES ('Post B') RETURNING id`
  const [t1] = await db.raw<{ id: number }>`INSERT INTO mt_tags (name) VALUES ('rust') RETURNING id`
  const [t2] = await db.raw<{ id: number }>`INSERT INTO mt_tags (name) VALUES ('typescript') RETURNING id`
  const [t3] = await db.raw<{ id: number }>`INSERT INTO mt_tags (name) VALUES ('bun') RETURNING id`

  // Link: Post A → rust, typescript; Post B → typescript, bun
  await db.raw`INSERT INTO mt_post_tags ("postId", "tagId") VALUES (${p1!.id}, ${t1!.id})`
  await db.raw`INSERT INTO mt_post_tags ("postId", "tagId") VALUES (${p1!.id}, ${t2!.id})`
  await db.raw`INSERT INTO mt_post_tags ("postId", "tagId") VALUES (${p2!.id}, ${t2!.id})`
  await db.raw`INSERT INTO mt_post_tags ("postId", "tagId") VALUES (${p2!.id}, ${t3!.id})`

  // Load posts with tags via hasManyThrough — fully typed!
  const postsWithTags = await PostRepo.findMany(q => q.include('tags'))

  for (const post of postsWithTags) {
    const tagNames = post.tags.map(t => t.name).join(', ')

    console.log(`${post.title}: [${tagNames}]`)
  }

  // Verify correctness
  const postA = postsWithTags.find(p => p.title === 'Post A')
  const postB = postsWithTags.find(p => p.title === 'Post B')

  const aOk = postA?.tags.length === 2 && postA.tags.some(t => t.name === 'rust')
  const bOk = postB?.tags.length === 2 && postB.tags.some(t => t.name === 'bun')

  console.log(`hasManyThrough: ${aOk && bOk ? 'PASS' : 'FAIL'}`)

  // Cleanup
  await db.raw`DROP TABLE IF EXISTS mt_post_tags`
  await db.raw`DROP TABLE IF EXISTS mt_posts`
  await db.raw`DROP TABLE IF EXISTS mt_tags`
  await db.close()
}

await main()
