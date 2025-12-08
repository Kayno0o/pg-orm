# @kaynooo/pg-orm

Type-safe ORM for Bun + PostgreSQL with builder pattern API.

## Install

```bash
bun add @kaynooo/pg-orm
```

## Quick Start

```typescript
import { orm } from '@kaynooo/pg-orm'

await orm.connect(process.env.DATABASE_URL!)

const User = orm.entity('users', {
  name: orm.string(),
  email: orm.string().unique(),
  age: orm.number().nullable()
}).build()

const users = orm.repo(User)

const user = await users.create({
  name: 'John',
  email: 'john@example.com'
})
```

## Field Types

```typescript
orm.string().maxLength(255).unique()
orm.number().integer().min(0).max(100)
orm.boolean().default(false)
orm.uuid().autoGenerate()
orm.timestamp().default('NOW()')
orm.date().nullable()
orm.array('string') // TEXT[]
orm.enum(['admin', 'user'])
orm.jsonb<Type>()
orm.blob()
```

## Traits

```typescript
import { timestamps, softDelete } from '@kaynooo/pg-orm'

const Post = orm.entity('posts', { title: orm.string() })
  .use(timestamps())
  .use(softDelete())
  .build()
```

## Queries

```typescript
await users.query()
  .where('age', '>=', 18)
  .whereIn('role', ['admin', 'moderator'])
  .orderBy('name', 'ASC')
  .limit(10)
  .execute()
```

## Transactions

```typescript
await users.transaction(async (txUsers) => {
  const user = await txUsers.create({ name: 'John' })
  await txUsers.update(user.id, { name: 'Jane' })
})
```

## Migrations

```typescript
await orm.migration.generate('add_fields')
await orm.migration.run()
await orm.migration.status()
```

## Advanced: Multiple Databases

Create independent ORM instances for different databases or multi-tenant setups:

```typescript
import { ORM } from '@kaynooo/pg-orm'

// Separate databases
const userDb = new ORM()
const analyticsDb = new ORM()

await userDb.connect('postgresql://users_db')
await analyticsDb.connect('postgresql://analytics_db')

const User = userDb.entity('users', { ... }).build()
const Event = analyticsDb.entity('events', { ... }).build()

// Multi-tenant with schemas
const tenant1 = new ORM()
const tenant2 = new ORM()

await tenant1.connect({ database: 'app', schema: 'tenant_1' })
await tenant2.connect({ database: 'app', schema: 'tenant_2' })

// Share entity definition across tenants
const User = tenant1.entity('users', { ... }).build()
tenant2.registerEntity(User)

const users1 = tenant1.repo(User)
const users2 = tenant2.repo(User)
```

**Note:** Relations must reference entities from the same ORM instance.

## License

MIT
