import type { Identifiable } from './types'
import { getRepository } from './db'
import { EntityNotFoundError } from './errors'

export abstract class AbstractEntity implements Identifiable {
  id!: number

  async save(): Promise<this> {
    const repository = getRepository(this.constructor as any)
    const saved = await repository.persist(this as any)

    Object.assign(this, saved)

    return this
  }

  async reload(): Promise<this> {
    if (!this.id) {
      throw new Error('Cannot reload entity without id')
    }

    const repository = getRepository(this.constructor as any)
    const fresh = await repository.find(this.id)

    if (!fresh) {
      throw new EntityNotFoundError(this.constructor.name, this.id)
    }

    Object.assign(this, fresh)

    return this
  }

  async remove(): Promise<void> {
    if (!this.id) {
      throw new Error('Cannot remove entity without id')
    }

    const repository = getRepository(this.constructor as any)

    await repository.delete(this.id)
  }

  toObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    const proto = Object.getPrototypeOf(this)

    for (const key of Object.keys(this)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key)

      if (!descriptor || typeof descriptor.value !== 'function') {
        obj[key] = (this as any)[key]
      }
    }

    return obj
  }

  toJSON(): Record<string, unknown> {
    return this.toObject()
  }
}
