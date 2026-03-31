import type { InferEntity } from '../../src/index'
import { defineTable, optimisticLock, softDelete, timestamps } from '../../src/index'

// --- Shared table definitions for tests ---

const usersTableDef = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  email: t.text().notNull().unique(),
  age: t.int4().nullable(),
}))
  .withTrait(softDelete())
  .withTrait(timestamps())

const postsTableDef = defineTable('posts', t => ({
  id: t.serial().primaryKey(),
  title: t.text().notNull(),
  body: t.text().notNull(),
  authorId: t.int4().notNull(),
  publishedAt: t.timestamptz().nullable(),
}))

const commentsTableDef = defineTable('comments', t => ({
  id: t.serial().primaryKey(),
  body: t.text().notNull(),
  postId: t.int4().notNull(),
  authorId: t.int4().notNull(),
}))

export const tagsTable = defineTable('tags', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull().unique(),
}))

export const postTagsTable = defineTable('post_tags', t => ({
  postId: t.int4().notNull(),
  tagId: t.int4().notNull(),
}))

export const versionedItemsTable = defineTable('versioned_items', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  value: t.int4().notNull().default(0),
}))
  .withTrait(optimisticLock())

// Wire relations after all tables are defined
export const usersTable = usersTableDef.withRelations(r => ({
  posts: r.hasMany<InferEntity<typeof postsTableDef>>('posts', 'authorId'),
}))

export const postsTable = postsTableDef.withRelations(r => ({
  author: r.belongsTo<InferEntity<typeof usersTable>>('users', 'authorId'),
  comments: r.hasMany<InferEntity<typeof commentsTableDef>>('comments', 'postId'),
  tags: r.hasManyThrough<InferEntity<typeof tagsTable>>('tags', 'post_tags', { from: 'postId', to: 'tagId' }),
}))

export const commentsTable = commentsTableDef.withRelations(r => ({
  post: r.belongsTo<InferEntity<typeof postsTable>>('posts', 'postId'),
  author: r.belongsTo<InferEntity<typeof usersTable>>('users', 'authorId'),
}))

export const itemsTable = defineTable('items', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  tags: t.array(t.text()).notNull().default([]),
  scores: t.array(t.int4()).nullable(),
}))

export const allTables = [
  usersTable,
  postsTable,
  commentsTable,
  tagsTable,
  postTagsTable,
  versionedItemsTable,
  itemsTable,
]
