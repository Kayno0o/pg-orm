import { AbstractEntity, Column, Entity, getRepository } from '../../src'
import { Tag } from './Tag'

@Entity('user')
export class User extends AbstractEntity {
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

  getTag(): Tag | null {
    if (!this.tag_id) {
      return null
    }

    return null // Would need to make this async in real usage
  }

  async getTagAsync(): Promise<Tag | null> {
    if (!this.tag_id) {
      return null
    }

    return await getRepository(Tag).find(this.tag_id)
  }
}
