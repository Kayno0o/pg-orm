# Security Guide

@kaynooo/pg-orm is built with security as a core principle. This guide explains the security features, best practices, and protection mechanisms built into the ORM.

## Table of Contents

- [SQL Injection Protection](#sql-injection-protection)
- [DoS Protection](#dos-protection)
- [Identifier Validation](#identifier-validation)
- [Mass Assignment Protection](#mass-assignment-protection)
- [Best Practices](#best-practices)
- [Security Configuration](#security-configuration)

## SQL Injection Protection

### Parameterized Queries

All user input is automatically parameterized using Bun's SQL tagged template literals. This prevents SQL injection attacks by treating user data as values, not executable code.

**✅ Safe (Automatic)**
```typescript
// All queries use parameterized inputs
const users = await userRepo.query()
  .where('email', '=', userInput) // Automatically parameterized
  .execute()

// Even complex queries are safe
const result = await userRepo.query()
  .where('name', 'LIKE', `%${searchTerm}%`) // Parameterized
  .whereIn('role', untrustedRoleList) // Parameterized array
  .execute()
```

**❌ NOT Possible**
```typescript
// You CANNOT bypass parameterization
// The ORM does not expose raw query building
await db`SELECT * FROM users WHERE name = '${userInput}'` // Would need direct DB access
```

### Column Name Validation

All table and column names go through strict validation to prevent SQL injection through identifiers.

```typescript
// ✅ Valid identifiers
orm.entity('users', f => ( ... })
orm.entity('user_profiles', f => ( ... })
field.column('email_address')

// ❌ Invalid identifiers (throws InvalidIdentifierError)
orm.entity('users; DROP TABLE users; --', { ... })
field.column('id) OR 1=1 --')
```

**Validation Rules:**
- Must start with letter or underscore
- Can contain letters, numbers, underscores
- Maximum 63 characters (PostgreSQL limit)
- No SQL keywords (SELECT, DROP, etc.)
- No special characters or spaces

## DoS Protection

The ORM includes multiple layers of protection against Denial of Service attacks.

### Bulk Operation Limits

Prevent memory exhaustion from extremely large batch operations.

```typescript
await orm.connect({
  hostname: 'localhost',
  database: 'mydb',
  limits: {
    bulkOperations: 1000 // Max items in createMany/deleteMany
  }
})

// ✅ Allowed
await userRepo.createMany(arrayOf1000Users)

// ❌ Throws BulkOperationError
await userRepo.createMany(arrayOf10000Users)
```

**Default:** 1,000 items per operation

### Array Size Limits

Protect against excessive array field sizes.

```typescript
await orm.connect({
  limits: {
    arraySize: 1000 // Max elements in array fields
  }
})

const User = orm.entity('users', f => ({
  tags: f.array('string')
})).build()

// ❌ Validation fails if array exceeds limit
await users.create({
  name: 'Test',
  tags: new Array(2000).fill('tag') // Too large
})
```

**Default:** 1,000 elements

### String Length Limits

Prevent memory attacks via extremely long strings.

```typescript
await orm.connect({
  limits: {
    stringLength: 1_000_000 // 1 million characters
  }
})

const User = orm.entity('users', f => ({
  bio: f.string() // No maxLength specified
})).build()

// ❌ Validation fails
await users.create({
  name: 'Test',
  bio: 'x'.repeat(2_000_000) // Exceeds global limit
})
```

**Default:** 1,000,000 characters (1 MB)

**Best Practice:** Always set explicit `maxLength()` on string fields:

```typescript
const User = orm.entity('users', f => ({
  email: f.string().maxLength(255),
  bio: f.string().maxLength(5000),
  name: f.string().maxLength(100)
})).build()
```

### JSON Size and Depth Limits

Protect against deeply nested JSON causing stack overflow and excessive memory usage.

```typescript
await orm.connect({
  limits: {
    jsonSize: 10_000_000, // 10 MB
    jsonDepth: 32         // Max nesting levels
  }
})

const User = orm.entity('users', f => ({
  metadata: f.jsonb<any>()
})).build()

// ❌ Validation fails - too deeply nested
let deepObject: any = { value: 'data' }
for (let i = 0; i < 40; i++) {
  deepObject = { nested: deepObject }
}
await users.create({ metadata: deepObject })
```

**Defaults:**
- `jsonSize`: 10,000,000 bytes (10 MB)
- `jsonDepth`: 32 levels

**Why depth matters:**
- Stack overflow risk with recursive parsing
- Polynomial time complexity in depth
- Memory amplification attacks

### Query Result Limits

Always use pagination or limits on queries to prevent unbounded result sets.

```typescript
// ✅ Good - Limited results
const recentUsers = await userRepo.query()
  .orderBy('created_at', 'DESC')
  .limit(100)
  .execute()

// ✅ Good - Paginated
const page = await userRepo.paginate({
  page: 1,
  pageSize: 50,
  where: { isActive: true }
})

// ⚠️ Caution - May return millions of rows
const allUsers = await userRepo.findAll()
```

## Identifier Validation

All SQL identifiers (tables, columns) are validated to prevent injection.

### Validation Function

```typescript
import { validateSQLIdentifier } from '@kaynooo/pg-orm/sql-utils'

// Throws InvalidIdentifierError if invalid
validateSQLIdentifier('tableName', 'table')
validateSQLIdentifier('columnName', 'column')
```

### Protected Operations

```typescript
// Table names validated
orm.entity('users', f => ( ... }) // ✅
orm.entity('users; DROP TABLE', { ... }) // ❌ InvalidIdentifierError

// Column names validated
field.column('email') // ✅
field.column('email) OR 1=1--') // ❌ InvalidIdentifierError

// Query builder validates field names
userRepo.query()
  .where('email', '=', value) // ✅ Field exists in schema
  .where('unknown_field', '=', value) // Would cause runtime error
```

### Reserved Keywords

The following SQL keywords are blocked as identifiers:

```
SELECT, INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, TRUNCATE,
FROM, WHERE, JOIN, UNION, ORDER, GROUP, HAVING, LIMIT, OFFSET
```

## Mass Assignment Protection

The ORM uses explicit schemas to prevent mass assignment vulnerabilities.

### Schema-Based Validation

Only fields defined in the schema can be set:

```typescript
const User = orm.entity('users', f => ({
  name: f.string(),
  email: f.string(),
  role: f.enum(['admin', 'user'])
})).build()

// ✅ Only defined fields accepted
await users.create({
  name: 'John',
  email: 'john@example.com',
  role: 'user'
})

// ❌ Extra fields ignored (type error at compile time)
await users.create({
  name: 'John',
  email: 'john@example.com',
  role: 'admin',
  isAdmin: true // TypeScript error - not in schema
})
```

### Role Escalation Prevention

Never trust client input for sensitive fields. Use separate schemas or validation:

```typescript
// ❌ BAD - Client can set role
app.post('/register', async (req) => {
  const user = await users.create(req.body) // Could contain role: 'admin'
})

// ✅ GOOD - Explicitly control sensitive fields
app.post('/register', async (req) => {
  const { name, email } = req.body
  const user = await users.create({
    name,
    email,
    role: 'user' // Always set to default
  })
})

// ✅ GOOD - Use hooks for access control
const User = orm.entity('users', f => ({
  role: f.enum(['admin', 'user'])
})
.beforeCreate((data) => {
  // Override any role assignment from client
  if (!isAuthorizedToSetRole(currentUser)) {
    data.role = 'user'
  }
})
.build()
```

## Best Practices

### 1. Enable Strict Validation Mode

Prevent developers from skipping validation in production:

```typescript
await orm.connect({
  validation: {
    strict: true // Disables skipValidation option
  }
})

// ❌ Throws error in strict mode
await users.createMany(data, { skipValidation: true })
```

### 2. Always Validate Field Constraints

```typescript
const User = orm.entity('users', f => ({
  email: f.string()
    .maxLength(255) // Prevent DoS
    .unique(),      // Business logic

  age: f.number()
    .min(0)         // Data integrity
    .max(150),      // Sanity check

  role: f.enum(['admin', 'user']), // Restrict values

  bio: f.string()
    .maxLength(5000) // Reasonable limit
})
```

### 3. Use Transactions for Sensitive Operations

```typescript
// Ensure atomicity for multi-step operations
await orm.transaction(async (tx) => {
  const txUsers = users.withTransaction(tx)
  const txAudit = auditLog.withTransaction(tx)

  await txUsers.update(userId, { role: 'admin' })
  await txAudit.create({
    action: 'ROLE_CHANGE',
    userId,
    timestamp: new Date()
  })

  // Both succeed or both rollback
})
```

### 4. Implement Rate Limiting

The ORM doesn't include rate limiting - implement this at the application layer:

```typescript
import rateLimit from 'express-rate-limit'

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // Limit each IP to 100 requests per window
})

app.use('/api/', limiter)
```

### 5. Log Security Events

```typescript
const User = orm.entity('users', f => ( ... })
  .afterCreate(async (user) => {
    await securityLog.create({
      event: 'USER_CREATED',
      userId: user.id,
      timestamp: new Date(),
      ip: getCurrentIP()
    })
  })
  .build()
```

### 6. Use Environment Variables

```typescript
// ❌ BAD - Hardcoded credentials
await orm.connect({
  hostname: 'localhost',
  password: 'mypassword123'
})

// ✅ GOOD - Environment variables
await orm.connect(process.env.DATABASE_URL!)
```

### 7. Implement Proper Error Handling

```typescript
try {
  await users.create(userData)
} catch (error) {
  if (error instanceof ValidationError) {
    // Don't expose internal validation details to client
    return { error: 'Invalid user data' }
  }

  if (error instanceof SQL.PostgresError && error.code === '23505') {
    // Unique constraint violation
    return { error: 'Email already exists' }
  }

  // Log internal errors, show generic message
  logger.error(error)
  return { error: 'Internal server error' }
}
```

## Security Configuration

### Full Example

```typescript
await orm.connect({
  hostname: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  // SSL for production
  ssl: process.env.NODE_ENV === 'production',

  // Connection pool limits
  max: 20,
  min: 2,
  idleTimeout: 30,

  // DoS Protection
  limits: {
    bulkOperations: 1000,
    arraySize: 1000,
    stringLength: 1_000_000,
    jsonSize: 10_000_000,
    jsonDepth: 32
  },

  // Validation
  validation: {
    strict: process.env.NODE_ENV === 'production'
  }
})
```

### Testing Security

```typescript
import { describe, test, expect } from 'bun:test'

describe('Security Tests', () => {
  test('should reject SQL injection attempts', async () => {
    const maliciousInput = "'; DROP TABLE users; --"

    // Query automatically parameterizes
    const result = await users.query()
      .where('email', '=', maliciousInput)
      .execute()

    // Returns empty array, doesn't execute DROP
    expect(result).toEqual([])
  })

  test('should reject deeply nested JSON', async () => {
    let deepObject: any = { value: 'data' }
    for (let i = 0; i < 50; i++) {
      deepObject = { nested: deepObject }
    }

    expect(async () => {
      await users.create({
        name: 'Test',
        metadata: deepObject
      })
    }).toThrow(ValidationError)
  })

  test('should reject excessive bulk operations', async () => {
    const tooManyUsers = new Array(10000).fill({
      name: 'Test',
      email: 'test@example.com'
    })

    expect(async () => {
      await users.createMany(tooManyUsers)
    }).toThrow(BulkOperationError)
  })
})
```

## Reporting Security Issues

If you discover a security vulnerability, please email security@kaynooo.dev instead of opening a public issue.

## Security Checklist

- [ ] Enable strict validation in production
- [ ] Set appropriate DoS protection limits
- [ ] Use SSL for database connections
- [ ] Validate all string field lengths
- [ ] Never trust client input for sensitive fields
- [ ] Use transactions for multi-step operations
- [ ] Implement rate limiting at application layer
- [ ] Log security-relevant events
- [ ] Use environment variables for credentials
- [ ] Handle errors without exposing internals
- [ ] Test for SQL injection attempts
- [ ] Test DoS protection limits
- [ ] Review schema for mass assignment risks

## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [PostgreSQL Security Best Practices](https://www.postgresql.org/docs/current/security.html)
- [Bun Security](https://bun.sh/docs/runtime/security)
