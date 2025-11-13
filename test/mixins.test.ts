import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  AbstractEntity,
  AbstractRepository,
  closeDB,
  Column,
  CreatedAt,
  Entity,
  getDB,
  getRepository,
  initDB,
  SoftDelete,
  UpdatedAt,
  withParanoid,
  withScopes,
  withSoftDelete,
  withTimestamps,
} from '../src'

// ============================================================================
// Test Entities
// ============================================================================

@Entity('post')
class Post extends AbstractEntity {
  @Column('text')
  title!: string

  @Column('text', { nullable: true })
  content?: string | null

  @SoftDelete()
  deleted_at?: Date | null
}

@Entity('article_ts')
class ArticleWithTimestamps extends AbstractEntity {
  @Column('text')
  title!: string

  @CreatedAt()
  created_at!: Date

  @UpdatedAt()
  updated_at!: Date
}

@Entity('document')
class Document extends AbstractEntity {
  @Column('text')
  title!: string

  @SoftDelete()
  deleted_at?: Date | null

  @CreatedAt()
  created_at!: Date

  @UpdatedAt()
  updated_at!: Date
}

@Entity('note')
class Note extends AbstractEntity {
  @Column('text')
  title!: string

  @Column('int', { default: 0 })
  views!: number
}

// ============================================================================
// Test Repositories with Mixins
// ============================================================================

class PostRepository extends withSoftDelete(AbstractRepository<Post>) {
  constructor() {
    super(Post)
  }
}

class ArticleRepository extends withTimestamps(AbstractRepository<ArticleWithTimestamps>) {
  constructor() {
    super(ArticleWithTimestamps)
  }
}

class DocumentRepository extends withParanoid(AbstractRepository<Document>) {
  constructor() {
    super(Document)
  }
}

class NoteRepository extends withScopes(AbstractRepository<Note>) {
  constructor() {
    super(Note)
  }
}

// ============================================================================
// Test Setup
// ============================================================================

async function createTables() {
  const db = getDB()

  // Drop and create post table
  await db`DROP TABLE IF EXISTS post CASCADE`
  await db`
    CREATE TABLE post (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      deleted_at TIMESTAMP WITH TIME ZONE
    )
  `

  // Drop and create article_ts table
  await db`DROP TABLE IF EXISTS article_ts CASCADE`
  await db`
    CREATE TABLE article_ts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL
    )
  `

  // Drop and create document table
  await db`DROP TABLE IF EXISTS document CASCADE`
  await db`
    CREATE TABLE document (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      deleted_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL
    )
  `

  // Drop and create note table
  await db`DROP TABLE IF EXISTS note CASCADE`
  await db`
    CREATE TABLE note (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      views INTEGER DEFAULT 0
    )
  `
}

// ============================================================================
// Soft Delete Tests
// ============================================================================

describe('withSoftDelete Mixin', () => {
  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/orm_test'

    await initDB(dbUrl, [new PostRepository()])
    await createTables()
  })

  afterAll(async () => {
    await closeDB()
  })

  beforeEach(async () => {
    const db = getDB()

    await db`DELETE FROM post`
    await db`ALTER SEQUENCE post_id_seq RESTART WITH 1`
  })

  test('should soft delete entity instead of removing it', async () => {
    const postRepo = getRepository(Post) as PostRepository

    const post = await postRepo.create({
      title: 'Test Post',
      content: 'This is a test',
    })

    await postRepo.delete(post.id)

    // Entity should still exist in database with deleted_at set
    const deletedPost = await postRepo.findWithTrashed(post.id)

    expect(deletedPost).not.toBeNull()
    expect((deletedPost as Post).deleted_at).toBeInstanceOf(Date)
  })

  test('find should not return soft deleted entities', async () => {
    const postRepo = getRepository(Post) as PostRepository

    const post = await postRepo.create({
      title: 'Test Post',
    })

    await postRepo.delete(post.id)

    const found = await postRepo.find(post.id)

    expect(found).toBeNull()
  })

  test('findAll should not return soft deleted entities', async () => {
    const postRepo = getRepository(Post) as PostRepository

    await postRepo.create({ title: 'Post 1' })
    const post2 = await postRepo.create({ title: 'Post 2' })

    await postRepo.create({ title: 'Post 3' })

    await postRepo.delete(post2.id)

    const posts = await postRepo.findAll()

    expect(posts.length).toBe(2)
    expect(posts.every(p => p.id !== post2.id)).toBe(true)
  })

  test('should restore soft deleted entities', async () => {
    const postRepo = getRepository(Post) as PostRepository

    const post = await postRepo.create({ title: 'Test Post' })

    await postRepo.delete(post.id)

    const restored = await postRepo.restore(post.id)

    expect((restored as Post).deleted_at).toBeNull()

    const found = await postRepo.find(post.id)

    expect(found).not.toBeNull()
    expect(found!.id).toBe(post.id)
  })

  test('should permanently delete with forceDelete', async () => {
    const postRepo = getRepository(Post) as PostRepository

    const post = await postRepo.create({ title: 'Test Post' })

    await postRepo.delete(post.id)

    // Verify soft delete worked
    const softDeleted = await postRepo.findWithTrashed(post.id)

    expect(softDeleted).not.toBeNull()

    // Force delete
    await postRepo.forceDelete(post.id)

    // Should not exist anywhere
    const gone = await postRepo.findWithTrashed(post.id)

    expect(gone).toBeNull()
  })

  test('findAllWithTrashed should return all entities including deleted', async () => {
    const postRepo = getRepository(Post) as PostRepository

    await postRepo.create({ title: 'Post 1' })
    const post2 = await postRepo.create({ title: 'Post 2' })

    await postRepo.create({ title: 'Post 3' })

    await postRepo.delete(post2.id)

    const allPosts = await postRepo.findAllWithTrashed()

    expect(allPosts.length).toBe(3)
  })

  test('findOnlyTrashed should return only deleted entities', async () => {
    const postRepo = getRepository(Post) as PostRepository

    await postRepo.create({ title: 'Post 1' })
    const post2 = await postRepo.create({ title: 'Post 2' })
    const post3 = await postRepo.create({ title: 'Post 3' })

    await postRepo.delete(post2.id)
    await postRepo.delete(post3.id)

    const trashedPosts = await postRepo.findOnlyTrashed()

    expect(trashedPosts.length).toBe(2)
    expect(trashedPosts.every(p => (p as Post).deleted_at !== null)).toBe(true)
  })

  test('count should not include soft deleted entities', async () => {
    const postRepo = getRepository(Post) as PostRepository

    await postRepo.create({ title: 'Post 1' })
    const post2 = await postRepo.create({ title: 'Post 2' })

    await postRepo.create({ title: 'Post 3' })

    await postRepo.delete(post2.id)

    const count = await postRepo.count()

    expect(count).toBe(2)
  })

  test('countWithTrashed should include soft deleted entities', async () => {
    const postRepo = getRepository(Post) as PostRepository

    await postRepo.create({ title: 'Post 1' })
    const post2 = await postRepo.create({ title: 'Post 2' })

    await postRepo.create({ title: 'Post 3' })

    await postRepo.delete(post2.id)

    const count = await postRepo.countWithTrashed()

    expect(count).toBe(3)
  })
})

// ============================================================================
// Timestamps Tests
// ============================================================================

describe('withTimestamps Mixin', () => {
  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/orm_test'

    await initDB(dbUrl, [new ArticleRepository()])
    await createTables()
  })

  afterAll(async () => {
    await closeDB()
  })

  beforeEach(async () => {
    const db = getDB()

    await db`DELETE FROM article_ts`
    await db`ALTER SEQUENCE article_ts_id_seq RESTART WITH 1`
  })

  test('should automatically set created_at and updated_at on create', async () => {
    const articleRepo = getRepository(ArticleWithTimestamps) as ArticleRepository

    const before = new Date()
    const article = await articleRepo.create({
      title: 'Test Article',
    })
    const after = new Date()

    expect(article.created_at).toBeInstanceOf(Date)
    expect(article.updated_at).toBeInstanceOf(Date)
    expect(article.created_at.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(article.created_at.getTime()).toBeLessThanOrEqual(after.getTime())
    expect(article.updated_at.getTime()).toBe(article.created_at.getTime())
  })

  test('should automatically update updated_at on update', async () => {
    const articleRepo = getRepository(ArticleWithTimestamps) as ArticleRepository

    const article = await articleRepo.create({
      title: 'Test Article',
    })

    // Wait a bit to ensure timestamp difference
    await new Promise(resolve => setTimeout(resolve, 10))

    const updated = await articleRepo.update(article.id, {
      title: 'Updated Article',
    })

    expect(updated.updated_at.getTime()).toBeGreaterThan(updated.created_at.getTime())
    expect(updated.created_at.getTime()).toBe(article.created_at.getTime())
  })

  test('should set timestamps on bulk create', async () => {
    const articleRepo = getRepository(ArticleWithTimestamps) as ArticleRepository

    const articles = await articleRepo.createMany([
      { title: 'Article 1' },
      { title: 'Article 2' },
      { title: 'Article 3' },
    ])

    expect(articles.length).toBe(3)
    for (const article of articles) {
      expect(article.created_at).toBeInstanceOf(Date)
      expect(article.updated_at).toBeInstanceOf(Date)
    }
  })
})

// ============================================================================
// Paranoid (Soft Delete + Timestamps) Tests
// ============================================================================

describe('withParanoid Mixin', () => {
  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/orm_test'

    await initDB(dbUrl, [new DocumentRepository()])
    await createTables()
  })

  afterAll(async () => {
    await closeDB()
  })

  beforeEach(async () => {
    const db = getDB()

    await db`DELETE FROM document`
    await db`ALTER SEQUENCE document_id_seq RESTART WITH 1`
  })

  test('should combine soft delete and timestamps', async () => {
    const docRepo = getRepository(Document) as DocumentRepository

    const doc = await docRepo.create({
      title: 'Test Document',
    })

    expect((doc as Document).created_at).toBeInstanceOf(Date)
    expect((doc as Document).updated_at).toBeInstanceOf(Date)
    expect((doc as Document).deleted_at).toBeNull()

    await docRepo.delete(doc.id)

    const deleted = await docRepo.findWithTrashed(doc.id)

    expect(deleted).not.toBeNull()
    expect((deleted as Document).deleted_at).toBeInstanceOf(Date)
  })

  test('should update timestamps when restoring', async () => {
    const docRepo = getRepository(Document) as DocumentRepository

    const doc = await docRepo.create({
      title: 'Test Document',
    })

    await docRepo.delete(doc.id)
    await new Promise(resolve => setTimeout(resolve, 10))

    const restored = await docRepo.restore(doc.id)

    expect((restored as Document).deleted_at).toBeNull()
    expect((restored as Document).updated_at.getTime()).toBeGreaterThan((doc as Document).updated_at.getTime())
  })
})

// ============================================================================
// Scopes Tests
// ============================================================================

describe('withScopes Mixin', () => {
  beforeAll(async () => {
    const dbUrl = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/orm_test'

    await initDB(dbUrl, [new NoteRepository()])
    await createTables()
  })

  afterAll(async () => {
    await closeDB()
  })

  beforeEach(async () => {
    const db = getDB()

    await db`DELETE FROM note`
    await db`ALTER SEQUENCE note_id_seq RESTART WITH 1`
  })

  test('latest should return newest entities', async () => {
    const noteRepo = getRepository(Note) as NoteRepository

    await noteRepo.create({ title: 'Note 1' })
    await new Promise(resolve => setTimeout(resolve, 10))
    await noteRepo.create({ title: 'Note 2' })
    await new Promise(resolve => setTimeout(resolve, 10))
    await noteRepo.create({ title: 'Note 3' })

    const latest = await noteRepo.latest('id', 2)

    expect(latest.length).toBe(2)
    expect(latest[0]!.id).toBeGreaterThan(latest[1]!.id)
  })

  test('oldest should return oldest entities', async () => {
    const noteRepo = getRepository(Note) as NoteRepository

    await noteRepo.create({ title: 'Note 1' })
    await noteRepo.create({ title: 'Note 2' })
    await noteRepo.create({ title: 'Note 3' })

    const oldest = await noteRepo.oldest('id', 2)

    expect(oldest.length).toBe(2)
    expect(oldest[0]!.id).toBeLessThan(oldest[1]!.id)
  })

  test('random should return random entities', async () => {
    const noteRepo = getRepository(Note) as NoteRepository

    // Create many notes
    for (let i = 1; i <= 10; i++) {
      await noteRepo.create({ title: `Note ${i}` })
    }

    const random = await noteRepo.random(5)

    expect(random.length).toBe(5)
  })

  test('first should return first entity', async () => {
    const noteRepo = getRepository(Note) as NoteRepository

    const note1 = await noteRepo.create({ title: 'First Note' })

    await noteRepo.create({ title: 'Second Note' })

    const first = await noteRepo.first()

    expect(first).not.toBeNull()
    expect(first!.id).toBe(note1.id)
  })

  test('last should return last entity by ID', async () => {
    const noteRepo = getRepository(Note) as NoteRepository

    await noteRepo.create({ title: 'First Note' })
    const note2 = await noteRepo.create({ title: 'Last Note' })

    const last = await noteRepo.last()

    expect(last).not.toBeNull()
    expect(last!.id).toBe(note2.id)
  })
})
