import type { EntitySchema, InferEntity } from '../types'

export type RelationType = 'hasOne' | 'hasMany' | 'belongsTo' | 'manyToMany'

export interface BaseRelationConfig<
  TSchema extends EntitySchema = any,
  TTraits extends readonly any[] = readonly [],
> {
  type: RelationType
  tableName: string
  foreignKey: string
  _phantom?: {
    schema: TSchema
    traits: TTraits
  }
}

export interface HasOneConfig<
  TSchema extends EntitySchema = any,
  TTraits extends readonly any[] = readonly [],
> extends BaseRelationConfig<TSchema, TTraits> {
  type: 'hasOne'
}

export interface HasManyConfig<
  TSchema extends EntitySchema = any,
  TTraits extends readonly any[] = readonly [],
> extends BaseRelationConfig<TSchema, TTraits> {
  type: 'hasMany'
}

export interface BelongsToConfig<
  TSchema extends EntitySchema = any,
  TTraits extends readonly any[] = readonly [],
> extends BaseRelationConfig<TSchema, TTraits> {
  type: 'belongsTo'
  ownerKey?: string
}

export interface ManyToManyConfig<
  TSchema extends EntitySchema = any,
  TTraits extends readonly any[] = readonly [],
> extends BaseRelationConfig<TSchema, TTraits> {
  type: 'manyToMany'
  through: string
  throughForeignKey: string
  otherKey: string
}

export type RelationConfig<
  TSchema extends EntitySchema = any,
  TTraits extends readonly any[] = readonly [],
> = HasOneConfig<TSchema, TTraits> | HasManyConfig<TSchema, TTraits> | BelongsToConfig<TSchema, TTraits> | ManyToManyConfig<TSchema, TTraits>
export type RelationSchema = Record<string, RelationConfig<any, any>>

export type InferRelation<R extends RelationConfig<any, any>>
  = R extends HasOneConfig<infer TSchema, infer TTraits>
    ? InferEntity<TSchema, TTraits> | null
    : R extends HasManyConfig<infer TSchema, infer TTraits>
      ? InferEntity<TSchema, TTraits>[]
      : R extends BelongsToConfig<infer TSchema, infer TTraits>
        ? InferEntity<TSchema, TTraits> | null
        : R extends ManyToManyConfig<infer TSchema, infer TTraits>
          ? InferEntity<TSchema, TTraits>[]
          : never

export type WithRelations<
  T extends EntitySchema,
  R extends RelationSchema,
  With extends (keyof R)[],
  TTraits extends readonly any[] = readonly [],
> = InferEntity<T, TTraits> & {
  [K in With[number]]: InferRelation<R[K]>
}
