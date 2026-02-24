/* eslint-disable max-lines-per-function */
// Showcase — runnable with: bun run examples/showcase.ts
// Highlights PG18 features (MERGE, JSONB subscripting) + new ORM features:
// aggregates, set operations, typed computed columns, JSON aggregates
// Requires: docker compose up -d (PG18 on localhost:8532)

import { Database, defineTable, SetOperationBuilder } from '../src/index'

interface ProductMetadata {
  color?: string
  tags?: string[]
}

// 1. Define tables for a product catalog
const _products = defineTable('sc_products', t => ({
  id: t.serial().primaryKey(),
  sku: t.text().notNull().unique(),
  name: t.text().notNull(),
  price: t.numeric(10, 2).notNull(),
  category: t.text().notNull().default('\'general\''),
  metadata: t.jsonb<ProductMetadata>().notNull().default('\'{}\''),
  stock: t.integer().notNull().default('0'),
  updatedAt: t.timestamptz().notNull().default('now()'),
}))

// Archived products — same shape, for demonstrating UNION
const _archivedProducts = defineTable('sc_archived_products', t => ({
  id: t.serial().primaryKey(),
  sku: t.text().notNull().unique(),
  name: t.text().notNull(),
  price: t.numeric(10, 2).notNull(),
  category: t.text().notNull().default('\'general\''),
  metadata: t.jsonb<ProductMetadata>().notNull().default('\'{}\''),
  stock: t.integer().notNull().default('0'),
  updatedAt: t.timestamptz().notNull().default('now()'),
}))

// 2. Define a staging table for inventory updates
const _staging = defineTable('sc_staging', t => ({
  sku: t.text().notNull().unique(),
  name: t.text().notNull(),
  price: t.numeric(10, 2).notNull(),
  stock: t.integer().notNull(),
}))

const db = new Database({
  url: 'postgres://test:test@localhost:8532/orm_test',
  tables: [_products, _archivedProducts, _staging],
})

const ProductRepo = db.repo(_products)
const ArchivedRepo = db.repo(_archivedProducts)
const StagingRepo = db.repo(_staging)

async function main() {
  console.log('--- PG18 Showcase ---')

  // Auto-migrate
  await db.sync({ allowDestructive: true })

  // Clean slate
  await db.raw`DELETE FROM sc_products`
  await db.raw`DELETE FROM sc_archived_products`
  await db.raw`DELETE FROM sc_staging`

  // 1. Seed initial products
  await ProductRepo.insertMany([
    { sku: 'P1', name: 'Product 1', price: '10.00', category: 'electronics', stock: 50, metadata: { color: 'red', tags: ['electronics'] } },
    { sku: 'P2', name: 'Product 2', price: '20.00', category: 'electronics', stock: 30, metadata: { color: 'blue', tags: ['home'] } },
    { sku: 'P3', name: 'Product 3', price: '35.00', category: 'home', stock: 15, metadata: { color: 'green' } },
    { sku: 'OLD', name: 'Old Product', price: '5.00', category: 'general', stock: 5, metadata: { color: 'gray' } },
  ])

  // Seed archived products
  await ArchivedRepo.insertMany([
    { sku: 'ARCH1', name: 'Archived Widget', price: '8.00', category: 'electronics', stock: 0, metadata: {} },
    { sku: 'ARCH2', name: 'Archived Gadget', price: '12.00', category: 'home', stock: 0, metadata: {} },
  ])

  // 2. Seed staging with updates and new items
  await StagingRepo.insertMany([
    { sku: 'P1', name: 'Product 1 Updated', price: '12.00', stock: 45 },
    { sku: 'P2', name: 'Product 2', price: '20.00', stock: 25 },
    { sku: 'NEW', name: 'New Product', price: '15.00', stock: 100 },
  ])

  console.log('Initial sync completed.')

  // 3. Showcase: MERGE with NOT MATCHED BY SOURCE
  console.log('\nRunning MERGE sync...')
  const mergeQuery = ProductRepo.merge()
    .using('sc_staging', 's')
    .on(e => e.raw('"sc_products"."sku" = "s"."sku"'))
    .whenMatched('update', {
      name: { __raw: '"s"."name"' },
      price: { __raw: '"s"."price"' },
      stock: { __raw: '"s"."stock"' },
      updatedAt: { __raw: 'now()' },
    })
    .whenNotMatched('insert', {
      sku: { __raw: '"s"."sku"' },
      name: { __raw: '"s"."name"' },
      price: { __raw: '"s"."price"' },
      stock: { __raw: '"s"."stock"' },
    })
    .whenNotMatchedBySourceDelete()

  const { sql, params } = mergeQuery.toSQL()

  console.log('SQL:', sql)
  await db.query(sql, params)

  const productsAfterMerge = await ProductRepo.findMany()

  console.log('Products after merge:', productsAfterMerge.length)
  for (const p of productsAfterMerge) {
    console.log(`- [${p.sku}] ${p.name}: $${p.price} (Stock: ${p.stock})`)
  }

  // 4. Showcase: JSONB Subscripting (PG18 feature)
  console.log('\nQuerying with JSONB Subscripting...')
  const redProducts = await ProductRepo.findMany(q =>
    q.where(e => e.eq(e.jsonbSubscript('metadata', 'color') as any, 'red')),
  )

  console.log('Red products found:', redProducts.length)
  for (const p of redProducts) {
    console.log(`- ${p.name} (Color: ${p.metadata.color})`)
  }

  const electronics = await ProductRepo.findMany(q =>
    q.where(e => e.eq(e.jsonbSubscript('metadata', 'tags', 0) as any, 'electronics')),
  )

  console.log('Electronics (first tag) found:', electronics.length)

  // --- NEW: Aggregate functions ---
  console.log('\n--- Aggregates ---')
  const stats = await ProductRepo.findMany(q =>
    q.aggregate(e => ({
      totalProducts: e.countCol(),
      totalStock: e.sum('stock'),
      avgPrice: e.avg('price'),
      minPrice: e.min('price'),
      maxPrice: e.max('price'),
    })),
  )

  console.log('Product stats:', stats[0])

  // --- NEW: Aggregates with GROUP BY ---
  console.log('\n--- Aggregates with GROUP BY ---')
  const byCategory = await ProductRepo.findMany(q =>
    q.aggregate(e => ({
      count: e.countCol(),
      avgPrice: e.avg('price'),
    }))
      .computed<string>('"category"', 'category')
      .groupBy('category'),
  )

  for (const row of byCategory) {
    console.log(`  ${(row as any).category}: ${row.count} products, avg price $${Number((row as any).avgPrice).toFixed(2)}`)
  }

  // --- NEW: JSON aggregates ---
  console.log('\n--- JSON Aggregates ---')
  const skusByCategory = await ProductRepo.findMany(q =>
    q.aggregate(e => ({
      skus: e.arrayAgg('sku'),
    }))
      .computed<string>('"category"', 'category')
      .groupBy('category'),
  )

  for (const row of skusByCategory) {
    console.log(`  ${(row as any).category}: [${(row as any).skus.join(', ')}]`)
  }

  // --- NEW: Set operations (UNION) ---
  console.log('\n--- Set Operations (UNION) ---')

  const activeQuery = ProductRepo.select().pick('sku', 'name', 'price')
  const archivedQuery = ArchivedRepo.select().pick('sku', 'name', 'price')

  const unionQuery = SetOperationBuilder.union(activeQuery, archivedQuery)
    .orderBy('name')

  const { sql: unionSql, params: unionParams } = unionQuery.toSQL()

  console.log('UNION SQL:', unionSql)
  const allProducts = await db.raw<{ sku: string, name: string, price: string }>(unionSql, unionParams)

  console.log(`All products (active + archived): ${allProducts.length}`)
  for (const p of allProducts) {
    console.log(`  - [${p.sku}] ${p.name}: $${p.price}`)
  }

  // --- NEW: Typed computed columns ---
  console.log('\n--- Typed Computed Columns ---')
  const withDiscount = await ProductRepo.findMany(q =>
    q.computed<number>('"price"::numeric * 0.9', 'discountedPrice'),
  )

  for (const p of withDiscount) {
    console.log(`  ${p.name}: $${p.price} -> $${Number((p as any).discountedPrice).toFixed(2)} (10% off)`)
  }

  // Cleanup
  await db.raw`DROP TABLE IF EXISTS sc_staging`
  await db.raw`DROP TABLE IF EXISTS sc_archived_products`
  await db.raw`DROP TABLE IF EXISTS sc_products`
  await db.close()

  console.log('\nShowcase finished.')
}

try {
  await main()
}
catch (err) {
  console.error(err)
  process.exit(1)
}
