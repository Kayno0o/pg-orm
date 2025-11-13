import { sql } from 'bun'
import { AbstractRepository, closeDB, initDB } from '../src'
import { Tag } from './entities/Tag'
import { User } from './entities/User'

/**
 * Setup test database
 */
export async function setupTestDB() {
  const dbUrl = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/orm_test'

  await initDB(dbUrl, [new AbstractRepository(Tag), new AbstractRepository(User)])
}

/**
 * Teardown test database
 */
export async function teardownTestDB() {
  await closeDB()
}

/**
 * Create tables for testing
 */
export async function createTables() {
  const db = sql as any

  // Drop tables if they exist
  await db`DROP TABLE IF EXISTS "user" CASCADE`
  await db`DROP TABLE IF EXISTS tag CASCADE`

  // Create tag table
  await db`
    CREATE TABLE tag (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT
    )
  `

  // Create user table
  await db`
    CREATE TABLE "user" (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      tag_id INTEGER REFERENCES tag(id) ON DELETE SET NULL,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `
}

/**
 * Clean up tables
 */
export async function cleanTables() {
  const db = sql as any

  await db`DELETE FROM "user"`
  await db`DELETE FROM tag`
  await db`ALTER SEQUENCE user_id_seq RESTART WITH 1`
  await db`ALTER SEQUENCE tag_id_seq RESTART WITH 1`
}
