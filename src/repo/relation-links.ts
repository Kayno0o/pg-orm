import type { Executable } from '../sql/executor'
import type { TransactionClient } from '../sql/transaction'
import type { AnyRelationDef, AnyRelations, AnyTableDef, HookContext } from '../types/index'
import type { Repository } from './index'
import { DEFAULT_PRIMARY_KEY } from '../constants'
import { ValidationError } from '../errors/index'
import { hasTrait } from '../schema/inspect'
import { relationKey } from '../utils/collection'

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

interface Through {
  pivot: AnyTableDef
  from: string
  to: string
}

function isLinkObject(target: unknown): target is { id: unknown, pivot: Record<string, unknown> } {
  return typeof target === 'object' && target !== null && 'id' in target && 'pivot' in target
}

/** Writes the pivot rows of a parent's hasManyThrough links, through the pivot's own repository so its hooks, traits and scopes apply. */
export class RelationLinks {
  constructor(
    private table: AnyTableDef,
    private executor: Executable,
    private hooks: HookContext,
    private registry?: ReadonlyMap<string, AnyTableDef>,
  ) {}

  async attach(parentId: unknown, relation: string, targets: LinkTarget<unknown>[], opts?: LinkOptions): Promise<unknown[]> {
    const through = this._through('attach', relation)

    return this._attach(this._repo(through), through, parentId, this._wanted(targets, opts))
  }

  async detach(parentId: unknown, relation: string, targetIds?: unknown[]): Promise<unknown[]> {
    const through = this._through('detach', relation)

    return this._detach(this._repo(through), through, parentId, targetIds)
  }

  // Reads the current links, detaches those not wanted and attaches the missing, all-or-nothing through the executor's `atomic`.
  async sync(parentId: unknown, relation: string, targets: LinkTarget<unknown>[], opts?: LinkOptions): Promise<SyncResult<unknown>> {
    const through = this._through('sync', relation)
    const wanted = this._wanted(targets, opts)
    const run = async (repo: PivotRepo): Promise<SyncResult<unknown>> => {
      const current = await this._linked(repo, through, parentId)
      const extra = [...current.values()].filter(id => !wanted.has(relationKey(id)))
      const detached = extra.length > 0 ? await this._detach(repo, through, parentId, extra) : []
      const missing = new Map([...wanted].filter(([key]) => !current.has(key)))

      return { attached: await this._attach(repo, through, parentId, missing), detached }
    }

    return this.executor.atomic ? this.executor.atomic(async exec => run(this._repo(through).using(exec as unknown as TransactionClient))) : run(this._repo(through))
  }

  private _through(method: string, relation: string): Through {
    const rel = (this.table.relations as AnyRelations | undefined)?.[relation] as AnyRelationDef | undefined

    if (rel?.type !== 'hasManyThrough')
      throw new ValidationError(`${method}(): "${relation}" is not a hasManyThrough relation of "${this.table.name}".`, method, { field: relation })

    const pk = this.table.primaryKey ?? DEFAULT_PRIMARY_KEY

    if (pk.includes(','))
      throw new ValidationError(`${method}("${relation}"): "${this.table.name}" has a composite primary key (${pk}), which a relation cannot join on.`, method, { field: relation })

    const pivot = this.registry?.get(rel.throughTable!)

    if (!pivot)
      throw new ValidationError(`${method}("${relation}"): "${rel.throughTable}" is not in the database's tables: list it in config.tables.`, method, { field: relation })

    return { pivot, from: rel.throughFrom!, to: rel.throughTo! }
  }

  private _repo(through: Through): PivotRepo {
    return this.hooks.repo(through.pivot)
  }

  // Each wanted target by its relation key, with the pivot columns its link is created with.
  private _wanted(targets: LinkTarget<unknown>[], opts?: LinkOptions): Map<unknown, { id: unknown, values: Row }> {
    const wanted = new Map<unknown, { id: unknown, values: Row }>()

    for (const target of targets) {
      const [id, pivot] = isLinkObject(target) ? [target.id, target.pivot] : [target, undefined]

      wanted.set(relationKey(id), { id, values: { ...opts?.pivot, ...pivot } })
    }

    return wanted
  }

  // The parent's live links, the target key each pivot row holds by its relation key.
  private async _linked(repo: PivotRepo, through: Through, parentId: unknown, ids?: unknown[]): Promise<Map<unknown, unknown>> {
    const rows: Row[] = await repo.read.findMany(q => q.pick(through.to).where({ [through.from]: parentId, ...ids && { [through.to]: ids } }))

    return new Map(rows.map(row => [relationKey(row[through.to]), row[through.to]]))
  }

  // A link a soft-delete pivot trashed is restored rather than inserted again, so a unique (from, to) index still holds; the target's pivot columns are written onto it.
  private async _attach(repo: PivotRepo, through: Through, parentId: unknown, wanted: Map<unknown, { id: unknown, values: Row }>): Promise<unknown[]> {
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
