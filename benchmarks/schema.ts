import { Database, defineTable, optimisticLock, softDelete, timestamps } from '../src/index'

// ── Table definitions ──

const _users = defineTable('bench_users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  email: t.varchar(255).notNull().unique(),
  role: t.text().notNull().default('user'),
  bio: t.text().nullable(),
}))

const _posts = defineTable('bench_posts', t => ({
  id: t.serial().primaryKey(),
  title: t.text().notNull(),
  body: t.text().notNull(),
  authorId: t.integer().notNull(),
  published: t.bool().notNull().default(false),
  views: t.integer().notNull().default(0),
}))

const _comments = defineTable('bench_comments', t => ({
  id: t.serial().primaryKey(),
  body: t.text().notNull(),
  postId: t.integer().notNull(),
  authorId: t.integer().notNull(),
}))

export const users = _users
  .withTrait(softDelete('deletedAt'))
  .withTrait(timestamps())
  .withTrait(optimisticLock())
  .withRelations(r => ({
    posts: r.hasMany(() => _posts, 'authorId'),
  }))

export const posts = _posts
  .withTrait(timestamps())
  .withTrait(optimisticLock())
  .withRelations(r => ({
    author: r.belongsTo(() => _users, 'authorId'),
    comments: r.hasMany(() => _comments, 'postId'),
  }))

export const comments = _comments
  .withTrait(timestamps())
  .withRelations(r => ({
    post: r.belongsTo(() => _posts, 'postId'),
    author: r.belongsTo(() => _users, 'authorId'),
  }))

// ── Database ──

export const BENCH_URL = process.env.DATABASE_URL ?? 'postgres://test:test@127.0.0.1:8532/orm_test'

export function createDb() {
  return new Database({
    url: BENCH_URL,
    pool: { max: 5 },
    tables: [users, posts, comments],
  })
}

// ── Seed ──

export async function seed(db: Database, userCount = 1000, postsPerUser = 5, commentsPerPost = 2) {
  const UserRepo = db.repo(users)
  const PostRepo = db.repo(posts)
  const CommentRepo = db.repo(comments)

  await db.sync({ allowDestructive: true })

  // Clean slate
  await db.raw`DELETE FROM bench_comments`
  await db.raw`DELETE FROM bench_posts`
  await db.raw`DELETE FROM bench_users`

  // Seed users in batches of 500
  const batchSize = 500
  const userIds: number[] = []

  for (let i = 0; i < userCount; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, userCount - i) }, (_, j) => ({
      name: `User ${i + j}`,
      email: `user${i + j}@bench.test`,
      role: j % 5 === 0 ? 'admin' : 'user',
      bio: j % 3 === 0 ? `Bio for user ${i + j} with some longer text to simulate real data` : null,
    }))
    const inserted = await UserRepo.write.insertMany(batch, { pk: true })

    userIds.push(...inserted)
  }

  // Seed posts in batches
  const postIds: number[] = []
  const totalPosts = userCount * postsPerUser

  for (let i = 0; i < totalPosts; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, totalPosts - i) }, (_, j) => {
      const idx = i + j

      return {
        title: `Post ${idx}`,
        body: `Body of post ${idx}. This is some content to simulate a real post with multiple sentences.`,
        authorId: userIds[idx % userIds.length]!,
        published: idx % 4 !== 0,
        views: Math.floor(Math.random() * 1000),
      }
    })
    const inserted = await PostRepo.write.insertMany(batch, { pk: true })

    postIds.push(...inserted)
  }

  // Seed comments in batches
  const totalComments = totalPosts * commentsPerPost

  for (let i = 0; i < totalComments; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, totalComments - i) }, (_, j) => {
      const idx = i + j

      return {
        body: `Comment ${idx} on a post`,
        postId: postIds[idx % postIds.length]!,
        authorId: userIds[idx % userIds.length]!,
      }
    })

    await CommentRepo.write.insertMany(batch, { pk: true })
  }

  return { userCount, postCount: totalPosts, commentCount: totalComments }
}
