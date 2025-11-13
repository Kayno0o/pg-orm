/**
 * Example usage of ORM v2
 * This demonstrates the same API as the original ORM
 */

import {
  AbstractEntity,
  AbstractRepository,
  Column,
  Entity,
  getRepository,
  initDB,
  QueryBuilder,
} from './src'

// Define entities (same as original)
@Entity('tag')
class Tag extends AbstractEntity {
  @Column('text', { nullable: false, unique: true })
  name!: string

  @Column('text', { nullable: true })
  description: string | null = null

  constructor(data?: Partial<Omit<Tag, 'id' | 'save'>>) {
    super()

    if (data) {
      this.name = data.name!

      if (data.description !== undefined) {
        this.description = data.description
      }
    }
  }
}

@Entity('user')
class User extends AbstractEntity {
  @Column('text', { nullable: false, unique: true })
  username!: string

  @Column('int', {
    nullable: true,
    reference: { table: 'tag', key: 'id' },
  })
  tag_id: number | null = null

  @Column('bool', { nullable: false, default: true })
  active = true

  constructor(data?: Partial<Omit<User, 'id' | 'save'>>) {
    super()

    if (data) {
      this.username = data.username!

      if (data.tag_id !== undefined) {
        this.tag_id = data.tag_id
      }

      if (data.active !== undefined) {
        this.active = data.active
      }
    }
  }

  async getTag(): Promise<Tag | null> {
    if (!this.tag_id)
      return null

    return await getRepository(Tag).find(this.tag_id)
  }
}

// Custom repository (optional - same as original)
class UserRepository extends AbstractRepository<User> {
  constructor() {
    super(User)
  }

  async findByUsername(username: string): Promise<User | null> {
    return await this.findOneBy({ where: { username } })
  }

  async findActiveUsers(): Promise<User[]> {
    return await this.findAllBy({ where: { active: true } })
  }
}

async function main() {
  // Initialize database (using PostgreSQL instead of SQLite)
  const dbUrl
    = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/orm_test'

  await initDB(dbUrl, [new UserRepository(), new AbstractRepository(Tag)])

  console.log('✓ Database initialized')

  // Get repositories
  const tagRepo = getRepository(Tag)
  const userRepo = getRepository(User)

  // Clean up existing data
  try {
    const existingUsers = await userRepo.findAll()

    for (const user of existingUsers) {
      await userRepo.delete(user.id)
    }
    const existingTags = await tagRepo.findAll()

    for (const tag of existingTags) {
      await tagRepo.delete(tag.id)
    }
  }
  catch (error) {
    // Tables might not exist yet
  }

  console.log('✓ Cleaned up existing data\n')

  // Example 1: Create entities (same API as original)
  console.log('Example 1: Creating entities')
  const adminTag = await tagRepo.create({
    name: 'admin',
    description: 'Administrator role',
  })

  console.log('  Created tag:', adminTag)

  const user1 = await userRepo.create({
    username: 'john_doe',
    tag_id: adminTag.id,
    active: true,
  })

  console.log('  Created user:', user1, '\n')

  // Example 2: Find by ID (same API as original)
  console.log('Example 2: Finding by ID')
  const foundUser = await userRepo.find(user1.id)

  console.log('  Found user:', foundUser, '\n')

  // Example 3: Find all (same API as original)
  console.log('Example 3: Finding all users')
  const user2 = await userRepo.create({
    username: 'jane_doe',
    tag_id: null,
    active: true,
  })
  const allUsers = await userRepo.findAll()

  console.log('  All users:', allUsers.length, 'users\n')

  // Example 4: Find with conditions (same API as original)
  console.log('Example 4: Finding with conditions')

  // By single value
  const johnUsers = await userRepo.findAllBy({
    where: { username: 'john_doe' },
  })

  console.log('  Users named john_doe:', johnUsers.length)

  // By array (IN clause)
  const multipleUsers = await userRepo.findAllBy({
    where: { id: [user1.id, user2.id] },
  })

  console.log('  Users by IDs:', multipleUsers.length)

  // With ordering
  const orderedUsers = await userRepo.findAllBy({
    order: { username: 'desc' },
  })

  console.log('  Ordered users:', orderedUsers.map(u => u.username))

  // With NOT NULL filter
  const usersWithTag = await userRepo.findAllBy({
    notNull: { tag_id: true },
  })

  console.log('  Users with tag:', usersWithTag.length, '\n')

  // Example 5: Update (same API as original)
  console.log('Example 5: Updating entities')
  const updatedUser = await userRepo.update(user1.id, {
    username: 'john_updated',
  })

  console.log('  Updated user:', updatedUser.username, '\n')

  // Example 6: Entity save() method
  console.log('Example 6: Using entity save() method')
  const newUser = new User({ username: 'alice', active: true })

  await newUser.save()
  console.log('  Created via save():', newUser.id)

  newUser.username = 'alicia'
  await newUser.save()
  console.log('  Updated via save():', newUser.username, '\n')

  // Example 7: Persist (same API as original)
  console.log('Example 7: Persist (upsert)')
  const persisted = await userRepo.persist({
    username: 'bob',
    active: false,
  })

  console.log('  Persisted (insert):', persisted.id)

  const updated = await userRepo.persist({
    id: persisted.id,
    username: 'bobby',
  })

  console.log('  Persisted (update):', updated.username, '\n')

  // Example 8: Custom repository method
  console.log('Example 8: Custom repository methods')
  const foundByUsername = await (
    userRepo as UserRepository
  ).findByUsername('alicia')

  console.log('  Found by username:', foundByUsername?.username)

  const activeUsers = await (userRepo as UserRepository).findActiveUsers()

  console.log('  Active users count:', activeUsers.length, '\n')

  // Example 9: Relationships
  console.log('Example 9: Relationships')
  const userWithTag = await userRepo.find(user1.id)

  if (userWithTag) {
    const tag = await userWithTag.getTag()

    console.log('  User tag:', tag?.name, '\n')
  }

  // Example 10: Query Builder (same API as original)
  console.log('Example 10: Query Builder')
  const qb = new QueryBuilder<User>('user', 'u')

  const complexQuery = await qb
    .select('u.id', 'u.username', 't.name as tag_name')
    .leftJoin('tag', 't', 'u.tag_id = t.id')
    .where('u.active = $1', true)
    .order('u.username', 'asc')
    .limit(10)
    .findAll()

  console.log(
    '  Complex query results:',
    complexQuery.map((r: any) => ({ username: r.username, tag: r.tag_name })),
    '\n',
  )

  // Example 11: Count with Query Builder
  console.log('Example 11: Count')
  const qb2 = new QueryBuilder<User>('user')
  const count = await qb2.where('active = $1', true).count()

  console.log('  Active users count:', count, '\n')

  // Example 12: Delete (same API as original)
  console.log('Example 12: Deleting entities')
  await userRepo.delete(persisted.id)
  const afterDelete = await userRepo.find(persisted.id)

  console.log('  After delete:', afterDelete === null ? 'deleted' : 'still exists', '\n')

  console.log('✓ All examples completed successfully!')
}

try {
  await main()
  process.exit(0)
}
catch (error) {
  console.error('Error:', error)
  process.exit(1)
}
