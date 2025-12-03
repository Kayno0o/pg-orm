import type { Repository } from './repository'
import type { EntityDefinition, EntitySchema, InferCreateData, InferEntity } from './types'

export type FactoryGenerator<T extends EntitySchema> = (index: number) => InferCreateData<T> | Promise<InferCreateData<T>>

export class Factory<
  T extends EntitySchema,
  TTraits extends readonly any[] = readonly any[],
  TScopes extends string = string,
> {
  private generatorFn: FactoryGenerator<T>
  private stateOverrides: Partial<InferCreateData<T>> = {}

  constructor(
    private entity: EntityDefinition<T, TTraits, TScopes>,
    private repository: Repository<T, TTraits, TScopes>,
    generator: FactoryGenerator<T>,
  ) {
    this.generatorFn = generator
  }

  state(overrides: Partial<InferCreateData<T>>): this {
    this.stateOverrides = { ...this.stateOverrides, ...overrides }

    return this
  }

  async make(count = 1): Promise<InferCreateData<T>[]> {
    const items: InferCreateData<T>[] = []

    for (let i = 0; i < count; i++) {
      const generated = await this.generatorFn(i)
      const merged = { ...generated, ...this.stateOverrides } as InferCreateData<T>

      items.push(merged)
    }

    return items
  }

  async makeOne(): Promise<InferCreateData<T>> {
    const [item] = await this.make(1)

    return item!
  }

  async create(count = 1): Promise<InferEntity<T, TTraits>[]> {
    const items = await this.make(count)

    return this.repository.createMany(items as any)
  }

  async createOne(): Promise<InferEntity<T, TTraits>> {
    const item = await this.makeOne()

    return this.repository.create(item)
  }

  raw(): FactoryGenerator<T> {
    return this.generatorFn
  }
}

export function defineFactory<
  T extends EntitySchema,
  TTraits extends readonly any[] = readonly any[],
  TScopes extends string = string,
>(
  entity: EntityDefinition<T, TTraits, TScopes>,
  repository: Repository<T, TTraits, TScopes>,
  generator: FactoryGenerator<T>,
): Factory<T, TTraits, TScopes> {
  return new Factory(entity, repository, generator)
}
