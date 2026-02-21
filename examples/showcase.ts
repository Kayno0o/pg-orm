// Showcase — runnable with: bun run examples/showcase.ts
// Highlights new PG18 features: MERGE (with NOT MATCHED BY SOURCE) and JSONB subscripting.
// Requires: docker compose up -d (PG18 on localhost:8532)

import { Database, defineTable } from '../src/index'

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
  tables: [_products, _staging],
})

const ProductRepo = db.repo(_products)
const StagingRepo = db.repo(_staging)

async function main() {
  console.log('--- PG18 Showcase ---')

  // Auto-migrate
  await db.sync({ allowDestructive: true })

  // Clean slate
  await db.raw`DELETE FROM sc_products`
  await db.raw`DELETE FROM sc_staging`

  // 1. Seed initial products
  await ProductRepo.insertMany([
    { sku: 'P1', name: 'Product 1', price: '10.00', stock: 50, metadata: { color: 'red', tags: ['electronics'] } },
    { sku: 'P2', name: 'Product 2', price: '20.00', stock: 30, metadata: { color: 'blue', tags: ['home'] } },
    { sku: 'OLD', name: 'Old Product', price: '5.00', stock: 5, metadata: { color: 'gray' } },
  ])

  // 2. Seed staging with updates and new items
  await StagingRepo.insertMany([
    { sku: 'P1', name: 'Product 1 Updated', price: '12.00', stock: 45 },
    { sku: 'P2', name: 'Product 2', price: '20.00', stock: 25 },
    { sku: 'NEW', name: 'New Product', price: '15.00', stock: 100 },
  ])

  console.log('Initial sync completed.')

  // 3. Showcase: MERGE with NOT MATCHED BY SOURCE
  // This syncs products table with staging table:
  // - MATCHED: update name, price, stock
  // - NOT MATCHED: insert new product
  // - NOT MATCHED BY SOURCE: delete (product exists in sc_products but not in sc_staging)
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
  // Select products where metadata['color'] is 'red'
  const redProducts = await ProductRepo.findMany(q =>
    q.where(e => e.eq(e.jsonbSubscript('metadata', 'color') as any, 'red')),
  )

  console.log('Red products found:', redProducts.length)
  for (const p of redProducts) {
    console.log(`- ${p.name} (Color: ${p.metadata.color})`)
  }

  // Nested subscripting: metadata['tags'][0]
  const electronics = await ProductRepo.findMany(q =>
    q.where(e => e.eq(e.jsonbSubscript('metadata', 'tags', 0) as any, 'electronics')),
  )

  console.log('Electronics (first tag) found:', electronics.length)

  // Cleanup
  await db.raw`DROP TABLE IF EXISTS sc_staging`
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
