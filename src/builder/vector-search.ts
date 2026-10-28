import { ValidationError } from '../errors/index'

const ITERATIVE_SCANS = new Set(['off', 'strict_order', 'relaxed_order'])

/** Per-query pgvector settings: each is applied with `SET LOCAL` in the transaction the statement runs in. */
export interface VectorSearchOptions {
  /** `hnsw.ef_search`: the candidate list an HNSW scan keeps (default 40). */
  efSearch?: number
  /** `ivfflat.probes`: the lists an IVFFlat scan visits (default 1). */
  probes?: number
  /** pgvector 0.8 iterative scans: keeps scanning the index while a filter leaves fewer rows than the LIMIT. `strict_order` is HNSW only, so an IVFFlat scan keeps `off` for it. */
  iterativeScan?: 'off' | 'strict_order' | 'relaxed_order'
  /** `hnsw.max_scan_tuples`: where an iterative HNSW scan stops (default 20000). */
  maxScanTuples?: number
  /** `ivfflat.max_probes`: where an iterative IVFFlat scan stops. */
  maxProbes?: number
}

/** The settings as `[name, value]`, checked here because they are bound as parameters of `set_config` but their values are read by the extension. */
export function vectorSearchSettings(opts: VectorSearchOptions): [string, string][] {
  const settings: [string, string][] = []
  const count = (key: keyof VectorSearchOptions, name: string): void => {
    const value = opts[key]

    if (value === undefined)
      return

    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
      throw new ValidationError(`vectorSearch(): ${key} must be a positive integer, got ${String(value)}.`, 'vectorSearch', { field: key, value })

    settings.push([name, String(value)])
  }

  count('efSearch', 'hnsw.ef_search')
  count('probes', 'ivfflat.probes')
  count('maxScanTuples', 'hnsw.max_scan_tuples')
  count('maxProbes', 'ivfflat.max_probes')

  if (opts.iterativeScan !== undefined) {
    if (!ITERATIVE_SCANS.has(opts.iterativeScan))
      throw new ValidationError(`vectorSearch(): iterativeScan must be off, strict_order or relaxed_order, got ${String(opts.iterativeScan)}.`, 'vectorSearch', { field: 'iterativeScan', value: opts.iterativeScan })

    settings.push(['hnsw.iterative_scan', opts.iterativeScan])

    if (opts.iterativeScan !== 'strict_order')
      settings.push(['ivfflat.iterative_scan', opts.iterativeScan])
  }

  return settings
}
