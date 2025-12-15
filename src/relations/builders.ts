import type { EntitySchema } from '../types'
import type {
  BelongsToConfig,
  HasManyConfig,
  HasOneConfig,
  ManyToManyConfig,
} from './types'
import { validateSQLIdentifier } from '../sql-utils'

export class HasOneBuilder<
  TSchema extends EntitySchema = any,
  TTraits extends readonly any[] = readonly [],
> {
  constructor(
    private tableName: string,
    private foreignKey: string,
  ) {
    validateSQLIdentifier(tableName, 'table')
    validateSQLIdentifier(foreignKey, 'column')
  }

  toConfig(): HasOneConfig<TSchema, TTraits> {
    return {
      type: 'hasOne',
      tableName: this.tableName,
      foreignKey: this.foreignKey,
    }
  }
}

export class HasManyBuilder<
  TSchema extends EntitySchema = any,
  TTraits extends readonly any[] = readonly [],
> {
  constructor(
    private tableName: string,
    private foreignKey: string,
  ) {
    validateSQLIdentifier(tableName, 'table')
    validateSQLIdentifier(foreignKey, 'column')
  }

  toConfig(): HasManyConfig<TSchema, TTraits> {
    return {
      type: 'hasMany',
      tableName: this.tableName,
      foreignKey: this.foreignKey,
    }
  }
}

export class BelongsToBuilder<
  TSchema extends EntitySchema = any,
  TTraits extends readonly any[] = readonly [],
> {
  private ownerKey = 'id'

  constructor(
    private tableName: string,
    private foreignKey: string,
  ) {
    validateSQLIdentifier(tableName, 'table')
    validateSQLIdentifier(foreignKey, 'column')
  }

  owner(key: string): this {
    validateSQLIdentifier(key, 'column')
    this.ownerKey = key

    return this
  }

  toConfig(): BelongsToConfig<TSchema, TTraits> {
    return {
      type: 'belongsTo',
      tableName: this.tableName,
      foreignKey: this.foreignKey,
      ownerKey: this.ownerKey,
    }
  }
}

export class ManyToManyBuilder<
  TSchema extends EntitySchema = any,
  TTraits extends readonly any[] = readonly [],
> {
  constructor(
    private tableName: string,
    private through: string,
    private throughForeignKey: string,
    private otherKey: string,
  ) {
    validateSQLIdentifier(tableName, 'table')
    validateSQLIdentifier(through, 'table')
    validateSQLIdentifier(throughForeignKey, 'column')
    validateSQLIdentifier(otherKey, 'column')
  }

  toConfig(): ManyToManyConfig<TSchema, TTraits> {
    return {
      type: 'manyToMany',
      tableName: this.tableName,
      through: this.through,
      throughForeignKey: this.throughForeignKey,
      otherKey: this.otherKey,
      foreignKey: this.throughForeignKey,
    }
  }
}

export const relation = {
  hasOne: <TSchema extends EntitySchema = any, TTraits extends readonly any[] = readonly []>(
    tableName: string,
    foreignKey: string,
  ) => new HasOneBuilder<TSchema, TTraits>(tableName, foreignKey),

  hasMany: <TSchema extends EntitySchema = any, TTraits extends readonly any[] = readonly []>(
    tableName: string,
    foreignKey: string,
  ) => new HasManyBuilder<TSchema, TTraits>(tableName, foreignKey),

  belongsTo: <TSchema extends EntitySchema = any, TTraits extends readonly any[] = readonly []>(
    tableName: string,
    foreignKey: string,
  ) => new BelongsToBuilder<TSchema, TTraits>(tableName, foreignKey),

  manyToMany: <TSchema extends EntitySchema = any, TTraits extends readonly any[] = readonly []>(
    tableName: string,
    through: string,
    throughForeignKey: string,
    otherKey: string,
  ) => new ManyToManyBuilder<TSchema, TTraits>(tableName, through, throughForeignKey, otherKey),
}
