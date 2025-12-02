import { orm } from '../src'

// Define entities
const User = orm.entity('users', {
  name: orm.string(),
  email: orm.string().unique(),
}).build()

const Post = orm.entity('posts', {
  title: orm.string(),
  content: orm.string(),
  userId: orm.number().foreignKey('users', 'id', { onDelete: 'CASCADE' }),
}).build()

const Comment = orm.entity('comments', {
  content: orm.string(),
  postId: orm.number().foreignKey('posts', 'id', { onDelete: 'CASCADE' }),
  userId: orm.number().foreignKey('users', 'id', { onDelete: 'CASCADE' }),
}).build()

// eslint-disable-next-line max-lines-per-function
async function demonstrateJoins() {
  // Connect to database
  await orm.connect({
    hostname: 'localhost',
    port: 5432,
    database: 'postgres',
    username: 'postgres',
    password: 'postgres',
  })

  // Get repositories
  const users = orm.repo(User)
  const posts = orm.repo(Post)
  const comments = orm.repo(Comment)

  // Create test data
  const alice = await users.create({
    name: 'Alice',
    email: 'alice@example.com',
  })

  const bob = await users.create({
    name: 'Bob',
    email: 'bob@example.com',
  })

  const post1 = await posts.create({
    title: 'First Post',
    content: 'This is the first post',
    userId: alice.id,
  })

  await comments.create({
    content: 'Great post!',
    postId: post1.id,
    userId: bob.id,
  })

  console.log('='.repeat(80))
  console.log('JOIN Examples')
  console.log('='.repeat(80))

  // Example 1: INNER JOIN - Get posts with user info
  console.log('\n1. INNER JOIN: Posts with user names')
  const postsWithUsers = await posts.query()
    .innerJoin('users', 'posts.user_id', '=', 'users.id')
    .execute()

  console.log(postsWithUsers)

  // Example 2: LEFT JOIN - Get all users and their posts (even users without posts)
  console.log('\n2. LEFT JOIN: All users with their posts')
  const usersWithPosts = await users.query()
    .leftJoin('posts', 'users.id', '=', 'posts.user_id')
    .execute()

  console.log(usersWithPosts)

  // Example 3: Multiple JOINs - Get comments with post and user info
  console.log('\n3. Multiple JOINs: Comments with post and user info')
  const commentsWithDetails = await comments.query()
    .innerJoin('posts', 'comments.post_id', '=', 'posts.id')
    .innerJoin('users', 'comments.user_id', '=', 'users.id')
    .execute()

  console.log(commentsWithDetails)

  // Example 4: JOIN with WHERE clause
  console.log('\n4. JOIN with WHERE: Alice\'s posts only')
  const alicePosts = await posts.query()
    .innerJoin('users', 'posts.user_id', '=', 'users.id')
    .where('userId', '=', alice.id)
    .execute()

  console.log(alicePosts)

  // Example 5: JOIN with ORDER BY and LIMIT
  console.log('\n5. JOIN with ORDER BY and LIMIT: Latest 2 posts with user info')
  const latestPosts = await posts.query()
    .innerJoin('users', 'posts.user_id', '=', 'users.id')
    .orderBy('title', 'DESC')
    .limit(2)
    .execute()

  console.log(latestPosts)

  // Example 6: RIGHT JOIN
  console.log('\n6. RIGHT JOIN: Posts with users')
  const rightJoinExample = await posts.query()
    .rightJoin('users', 'posts.user_id', '=', 'users.id')
    .execute()

  console.log(rightJoinExample)

  // Example 7: Using getDB() for custom queries
  console.log('\n7. Custom query using getDB()')
  const db = users.getDB()
  const customResults = await db`
    SELECT u.name, COUNT(p.id) as post_count
    FROM users u
    LEFT JOIN posts p ON u.id = p.user_id
    GROUP BY u.id, u.name
  `

  console.log(customResults)

  // Example 8: Inspect generated SQL
  console.log('\n8. Build and inspect SQL (without executing)')
  const { sql, params } = posts.query()
    .innerJoin('users', 'posts.user_id', '=', 'users.id')
    .where('title', 'LIKE', '%Post%')
    .orderBy('title', 'ASC')
    .build()

  console.log('Generated SQL:', sql)
  console.log('Parameters:', params)

  console.log(`\n${'='.repeat(80)}`)
  console.log('Examples completed!')
  console.log('='.repeat(80))

  await orm.disconnect()
}

// eslint-disable-next-line github/no-then
demonstrateJoins().catch(console.error)
