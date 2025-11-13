import { AbstractEntity, Column, Entity } from '../../src'

@Entity('tag')
export class Tag extends AbstractEntity {
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
