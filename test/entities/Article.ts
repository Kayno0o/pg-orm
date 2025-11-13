import { ArrayColumn, Column, CreatedAt, Entity, EnumColumn, JsonColumn, UpdatedAt, UuidColumn } from '../../src'
import { AbstractEntity } from '../../src/entity'

export enum ArticleStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}

@Entity('article')
export class Article extends AbstractEntity {
  @Column('text')
  title!: string

  @Column('text', { nullable: true })
  content?: string | null

  @UuidColumn()
  uuid!: string

  @EnumColumn(ArticleStatus)
  status!: ArticleStatus

  @JsonColumn({ nullable: true })
  metadata?: Record<string, unknown> | null

  @ArrayColumn('text', { nullable: true })
  tags?: string[] | null

  @ArrayColumn('int', { nullable: true })
  view_counts?: number[] | null

  @CreatedAt()
  created_at!: Date

  @UpdatedAt()
  updated_at!: Date

  @Column('int', { default: 0 })
  likes!: number
}
