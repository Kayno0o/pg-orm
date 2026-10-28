import type { Executable } from '../sql/executor'
import type { TransactionClient } from '../sql/transaction'
import type { AnyRelationDef, AnyRelations, AnyTableDef, HookContext } from '../types/index'
import type { Repository } from './index'
import { DEFAULT_PRIMARY_KEY } from '../constants'
import { NotFoundError, ValidationError } from '../errors/index'
import { hasTrait } from '../schema/inspect'
import { relationKey } from '../utils/collection'
import { assertKeyValue } from './table-runtime'

/** A target to link: its key, or its key and the pivot columns to set on the link. */
export type LinkTarget<TKey> = TKey | { id: TKey, pivot: Record<string, unknown> }

export interface LinkOptions {
  /** Pivot columns set on every link this call creates, under those a target gives. */
  pivot?: Record<string, unknown>
}

export interface SyncResult<TKey> {
  attached: TKey[]
  detached: TKey[]
}

type Row = Record<string, unknown>
type PivotRepo = Repository<any, any, any>
type RepoOf = (table: AnyTableDef) => PivotRepo
type Wanted = Map<unknown, { id: unknown, values: Row }>

interface Through {
  method: string
  relation: string
  pivot: AnyTableDef
  target: AnyTableDef
  targetKey: string
  from: string
  to: string
}

function isLinkObject(target: unknown): target is { id: unknown, pivot: Record<string, unknown> } {
  return typeof target === 'object' && target !== null && 'id' in target && 'pivot' in target
}

/**
 * Writes the pivot rows of a parent's hasManyThrough links, through the pivot's own repository so its hooks, traits and scopes apply.
 * Each call checks, in the same transaction as its writes, that the parent and every target to link are rows the scopes let it see.
 */
export class RelationLinks {
  constructor(
    private table: AnyTableDef,
    private executor: Executable,
    private hooks: HookContext,
    private registry?: ReadonlyMap<string, AnyTableDef>,
  ) {}

  async attach(parentId: unknown, relation: string, targets: LinkTarget<unknown>[], opts?: LinkOptions): Promise<unknown[]> {
    const through = this._through('attach', relation, parentId)
    const wanted = this._wanted(through, targets, opts)

    return this._atomic(parentId, async (repoOf) => {
      await this._checkTargets(repoOf, through, wanted)

      return this._attach(repoOf(through.pivot), through, parentId, wanted)
    })
  }

  async detach(parentId: unknown, relation: string, targetIds?: unknown[]): Promise<unknown[]> {
    const through = this._through('detach', relation, parentId)

    if (targetIds !== undefined && !Array.isArray(targetIds))
      throw new ValidationError(`detach("${relation}"): the target keys must be an array, or omitted to detach every link.`, 'detach', { field: relation })

    const ids = targetIds?.map(id => assertKeyValue(id, through.target.name, through.targetKey, 'detach'))

    return this._atomic(parentId, async repoOf => this._detach(repoOf(through.pivot), through, parentId, ids))
  }

  // Reads the current links, detaches those not wanted and attaches the missing.
  async sync(parentId: unknown, relation: string, targets: LinkTarget<unknown>[], opts?: LinkOptions): Promise<SyncResult<unknown>> {
    const through = this._through('sync', relation, parentId)
    const wanted = this._wanted(through, targets, opts)

    return this._atomic(parentId, async (repoOf) => {
      await this._checkTargets(repoOf, through, wanted)

      const repo = repoOf(through.pivot)
      const current = await this._linked(repo, through, parentId)
      const extra = [...current.values()].filter(id => !wanted.has(relationKey(id)))
      const detached = extra.length > 0 ? await this._detach(repo, through, parentId, extra) : []
      const missing = new Map([...wanted].filter(([key]) => !current.has(key)))

      return { attached: await this._attach(repo, through, parentId, missing), detached }
    })
  }

  private _through(method: string, relation: string, parentId: unknown): Through {
    const rel = (this.table.relations as AnyRelations | undefined)?.[relation] as AnyRelationDef | undefined

    if (rel?.type !== 'hasManyThrough')
      throw new ValidationError(`${method}(): "${relation}" is not a hasManyThrough relation of "${this.table.name}".`, method, { field: relation })

    const pivot = this._registered(method, relation, rel.throughTable!)
    const target = this._registered(method, relation, rel.targetTable)

    assertKeyValue(parentId, this.table.name, this._singleKey(method, relation, this.table), method)

    return { method, relation, pivot, target, targetKey: this._singleKey(method, relation, target), from: rel.throughFrom!, to: rel.throughTo! }
  }

  private _registered(method: string, relation: string, name: string): AnyTableDef {
    const table = this.registry?.get(name)

    if (!table)
      throw new ValidationError(`${method}("${relation}"): "${name}" is not in the database's tables: list it in config.tables.`, method, { field: relation })

    return table
  }

  private _singleKey(method: string, relation: string, table: AnyTableDef): string {
    const pk = table.primaryKey ?? DEFAULT_PRIMARY_KEY

    if (pk.includes(','))
      throw new ValidationError(`${method}("${relation}"): "${table.name}" has a composite primary key (${pk}), which a relation cannot join on.`, method, { field: relation })

    return pk
  }

  // The checks and writes share one transaction through the executor's `atomic`, so a failure part-way leaves no partial links.
  private async _atomic<T>(parentId: unknown, work: (repoOf: RepoOf) => Promise<T>): Promise<T> {
    const run = async (repoOf: RepoOf): Promise<T> => {
      if (!await repoOf(this.table).read.existsById(parentId))
        throw new NotFoundError(this.table.name)

      return work(repoOf)
    }

    if (!this.executor.atomic)
      return run(table => this.hooks.repo(table))

    return this.executor.atomic(async exec => run(table => this.hooks.repo(table).using(exec as unknown as TransactionClient)))
  }

  // Each wanted target by its relation key, with the pivot columns its link is created with.
  private _wanted(through: Through, targets: LinkTarget<unknown>[], opts?: LinkOptions): Wanted {
    const wanted: Wanted = new Map()

    for (const target of targets) {
      const [id, pivot] = isLinkObject(target) ? [target.id, target.pivot] : [target, undefined]

      assertKeyValue(id, through.target.name, through.targetKey, through.method)
      wanted.set(relationKey(id), { id, values: { ...opts?.pivot, ...pivot } })
    }

    return wanted
  }

  private async _checkTargets(repoOf: RepoOf, through: Through, wanted: Wanted): Promise<void> {
    if (wanted.size === 0)
      return

    const { targetKey } = through
    const rows: Row[] = await repoOf(through.target).read._findAll(q => q.pick(targetKey).where({ [targetKey]: [...wanted.values()].map(target => target.id) }))
    const seen = new Set(rows.map(row => relationKey(row[targetKey])))
    const missing = [...wanted].filter(([key]) => !seen.has(key)).map(([, target]) => String(target.id))

    if (missing.length > 0)
      throw new ValidationError(`${through.method}("${through.relation}"): no "${through.target.name}" row has the key ${missing.join(', ')}, or a scope hides it.`, through.method, { field: through.relation })
  }

  // The parent's live links, the target key each pivot row holds by its relation key.
  private async _linked(repo: PivotRepo, through: Through, parentId: unknown, ids?: unknown[]): Promise<Map<unknown, unknown>> {
    const rows: Row[] = await repo.read._findAll(q => q.pick(through.to).where({ [through.from]: parentId, ...ids && { [through.to]: ids } }))

    return new Map(rows.map(row => [relationKey(row[through.to]), row[through.to]]))
  }

  // A link a soft-delete pivot trashed is restored rather than inserted again, so a unique (from, to) index still holds; the target's pivot columns are written onto it.
  private async _attach(repo: PivotRepo, through: Through, parentId: unknown, wanted: Wanted): Promise<unknown[]> {
    if (wanted.size === 0)
      return []

    const live = await this._linked(repo, through, parentId, [...wanted.values()].map(target => target.id))
    const missing = [...wanted].filter(([key]) => !live.has(key))
    const restored = new Set<unknown>()

    if (missing.length > 0 && hasTrait(through.pivot, 'softDelete')) {
      const rows: Row[] = await repo.write.restore({ [through.from]: parentId, [through.to]: missing.map(([, target]) => target.id) })

      for (const row of rows)
        restored.add(relationKey(row[through.to]))

      for (const [key, target] of missing) {
        if (restored.has(key) && Object.keys(target.values).length > 0)
          await repo.write.updateMany(target.values, { [through.from]: parentId, [through.to]: target.id })
      }
    }

    const inserted = missing.filter(([key]) => !restored.has(key))

    if (inserted.length > 0)
      await repo.write.insertMany(inserted.map(([, target]) => ({ ...target.values, [through.from]: parentId, [through.to]: target.id })), { returning: false })

    return missing.map(([, target]) => target.id)
  }

  private async _detach(repo: PivotRepo, through: Through, parentId: unknown, targetIds?: unknown[]): Promise<unknown[]> {
    if (targetIds?.length === 0)
      return []

    const rows: Row[] = await repo.write.deleteMany({ [through.from]: parentId, ...targetIds && { [through.to]: targetIds } })

    return [...new Map(rows.map(row => [relationKey(row[through.to]), row[through.to]])).values()]
  }
}
