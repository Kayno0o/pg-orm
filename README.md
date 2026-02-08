# @kaynooo/pg-orm

Type-safe ORM for Bun + PostgreSQL with builder pattern API.

## Install

```bash
bun add @kaynooo/pg-orm
```

## Quick Start

```typescript
import { ORM } from '@kaynooo/pg-orm'

const orm = new ORM()
await orm.connect(process.env.DATABASE_URL!)

const User = orm.entity('users', f => ({
  name: f.string(),
  email: f.string().unique(),
  age: f.number().nullable()
})).build()

const users = orm.repo(User)

const user = await users.create({
  name: 'John',
  email: 'john@example.com'
})
```

## Field Types

```typescript
f.string().maxLength(255).unique()
f.number().integer().min(0).max(100)
f.boolean().default(false)
f.uuid()
f.timestamp().default('NOW()')
f.date().nullable()
f.array('string') // TEXT[]
f.enum(['admin', 'user'])
f.jsonb<Type>()
f.blob()
```

## Traits

```typescript
import { ORM, timestamps, softDelete } from '@kaynooo/pg-orm'

const orm = new ORM()

const Post = orm.entity('posts', f => ({ title: f.string() }))
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

const User = userDb.entity('users', f => ({ ... })).build()
const Event = analyticsDb.entity('events', f => ({ ... })).build()

// Multi-tenant with schemas
const tenant1 = new ORM()
const tenant2 = new ORM()

await tenant1.connect({ database: 'app', schema: 'tenant_1' })
await tenant2.connect({ database: 'app', schema: 'tenant_2' })

// Share entity definition across tenants
const UserShared = tenant1.entity('users', f => ({ ... })).build()
tenant2.registerEntity(UserShared)

const users1 = tenant1.repo(UserShared)
const users2 = tenant2.repo(UserShared)
```

## License

MIT
