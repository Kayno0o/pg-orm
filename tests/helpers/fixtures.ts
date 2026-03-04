import { defineTable, optimisticLock, softDelete, timestamps } from '../../src/index'

// --- Shared table definitions for tests ---

export const usersTable = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
  email: t.text().notNull().unique(),
  age: t.int4().nullable(),
}))
  .withTrait(softDelete())
  .withTrait(timestamps())

export const postsTable = defineTable('posts', t => ({
  id: t.serial().primaryKey(),
  title: t.text().notNull(),
  body: t.text().notNull(),
  authorId: t.int4().notNull(),
  publishedAt: t.timestamptz().nullable(),
}))

export const commentsTable = defineTable('comments', t => ({
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
  value: t.int4().notNull().default('0'),
}))
  .withTrait(optimisticLock())

// Wire relations after all tables are defined
usersTable.withRelations(r => ({
  posts: r.hasMany('posts', 'authorId'),
}))

postsTable.withRelations(r => ({
  author: r.belongsTo('users', 'authorId'),
  comments: r.hasMany('comments', 'postId'),
  tags: r.hasManyThrough('tags', 'post_tags', { from: 'postId', to: 'tagId' }),
}))

commentsTable.withRelations(r => ({
  post: r.belongsTo('posts', 'postId'),
  author: r.belongsTo('users', 'authorId'),
}))

export const allTables = [
  usersTable,
  postsTable,
  commentsTable,
  tagsTable,
  postTagsTable,
  versionedItemsTable,
]
