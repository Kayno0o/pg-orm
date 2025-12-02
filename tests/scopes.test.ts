import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import { setupTestDatabase, teardownTestDatabase } from './setup'

describe('Scopes', () => {
// Define entities at module level so migrations can run
  const User = orm.entity('scope_users', {
    name: orm.string(),
    email: orm.string(),
    is_active: orm.boolean(),
    role: orm.enum(['admin', 'user', 'moderator']),
  })
    .scope('active', q => q.where('is_active', '=', true))
    .scope('admins', q => q.where('role', '=', 'admin'))
    .build()

  const Product = orm.entity('scope_products', {
    name: orm.string(),
    price: orm.number(),
    in_stock: orm.boolean(),
    category: orm.string(),
  })
    .scope('affordable', q => q.where('price', '<=', 100))
    .scope('available', q => q.where('in_stock', '=', true))
    .scope('electronics', q => q.where('category', '=', 'electronics'))
    .build()

  const Post = orm.entity('scope_posts', {
    title: orm.string(),
    views: orm.number(),
    published: orm.boolean(),
  })
    .scope('popular', q => q.where('views', '>', 100).orderBy('views', 'DESC'))
    .scope('published', q => q.where('published', '=', true))
    .build()

  const Article = orm.entity('scope_articles', {
    title: orm.string(),
    status: orm.enum(['draft', 'published', 'archived']),
  })
    .scope('published', q => q.where('status', '=', 'published'))
    .scope('draft', q => q.where('status', '=', 'draft'))
    .build()

  beforeAll(async () => {
    // Register repositories before connecting to enable auto-migration
    orm.repo(User)
    orm.repo(Product)
    orm.repo(Post)
    orm.repo(Article)
    await setupTestDatabase()
  })

  afterAll(teardownTestDatabase)

  test('should define and use scopes', async () => {
    const users = orm.repo(User)

    // Create test data
    await users.create({ name: 'Alice', email: 'alice@test.com', is_active: true, role: 'admin' })
    await users.create({ name: 'Bob', email: 'bob@test.com', is_active: false, role: 'user' })
    await users.create({ name: 'Charlie', email: 'charlie@test.com', is_active: true, role: 'user' })
    await users.create({ name: 'Diana', email: 'diana@test.com', is_active: true, role: 'moderator' })

    // Test 'active' scope
    const activeUsersQuery = users.scope('active')
    const activeUsers = await activeUsersQuery.execute()

    expect(activeUsers).toHaveLength(3)
    expect(activeUsers.every((u: typeof activeUsers[0]) => u.is_active)).toBe(true)

    // Test 'admins' scope
    const adminUsers = await users.scope('admins').execute()

    expect(adminUsers).toHaveLength(1)
    expect(adminUsers[0].name).toBe('Alice')
    expect(adminUsers[0].role).toBe('admin')

    // Test scope chaining
    const activeAdmins = await users.scope('active').where('role', '=', 'admin').execute()

    expect(activeAdmins).toHaveLength(1)
    expect(activeAdmins[0].name).toBe('Alice')
  })

  test('should throw error for non-existent scope', () => {
    const users = orm.repo(User)

    expect(() => users.scope('nonexistent')).toThrow('Scope "nonexistent" not found')
  })

  test('should allow scope to add complex filters', async () => {
    const products = orm.repo(Product)

    // Create test data
    await products.create({ name: 'Laptop', price: 1200, in_stock: true, category: 'electronics' })
    await products.create({ name: 'Mouse', price: 25, in_stock: true, category: 'electronics' })
    await products.create({ name: 'Keyboard', price: 75, in_stock: false, category: 'electronics' })
    await products.create({ name: 'Desk', price: 200, in_stock: true, category: 'furniture' })

    // Test affordable electronics in stock
    const affordableElectronicsInStock = await products
      .scope('affordable')
      .scope('available')
      .scope('electronics')
      .execute()

    expect(affordableElectronicsInStock).toHaveLength(1)
    expect(affordableElectronicsInStock[0].name).toBe('Mouse')
  })

  test('should allow scope with ordering and limits', async () => {
    const posts = orm.repo(Post)

    // Create test data
    await posts.create({ title: 'Post 1', views: 50, published: true })
    await posts.create({ title: 'Post 2', views: 200, published: true })
    await posts.create({ title: 'Post 3', views: 150, published: true })
    await posts.create({ title: 'Post 4', views: 300, published: false })

    // Get popular published posts
    const popularPublished = await posts.scope('popular').scope('published').execute()

    expect(popularPublished).toHaveLength(2)
    expect(popularPublished[0].title).toBe('Post 2')
    expect(popularPublished[1].title).toBe('Post 3')
  })

  test('should count with scopes', async () => {
    const articles = orm.repo(Article)

    await articles.create({ title: 'Article 1', status: 'draft' })
    await articles.create({ title: 'Article 2', status: 'published' })
    await articles.create({ title: 'Article 3', status: 'published' })
    await articles.create({ title: 'Article 4', status: 'archived' })

    const publishedCount = await articles.scope('published').count()

    expect(publishedCount).toBe(2)

    const draftCount = await articles.scope('draft').count()

    expect(draftCount).toBe(1)
  })
})
