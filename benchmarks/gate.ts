import type { BenchmarkResult, RunResult } from './utils'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_THRESHOLD_PERCENT = 25

const BASELINES_DIR = join(import.meta.dir, 'baselines')

const RESET = '\x1B[0m'
const GREEN = '\x1B[32m'
const RED = '\x1B[31m'
const DIM = '\x1B[2m'

export function baselinePath(target: string): string {
  return join(BASELINES_DIR, `${target}.json`)
}

export function loadBaseline(target: string): RunResult | null {
  const path = baselinePath(target)

  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) as RunResult : null
}

export function saveBaseline(target: string, result: RunResult): string {
  mkdirSync(BASELINES_DIR, { recursive: true })
  const path = baselinePath(target)

  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`)

  return path
}

export interface GateRow {
  name: string
  current: number
  baseline: number
  changePercent: number
}

/** A benchmark fails the gate when its fastest sample (steadier than the median on a machine other jobs share) is more than `thresholdPercent` above the baseline's. Benchmarks missing on either side are reported, not failed. */
export function compareToBaseline(current: Record<string, BenchmarkResult>, baseline: Record<string, BenchmarkResult>, thresholdPercent: number) {
  const rows: GateRow[] = []

  for (const [name, now] of Object.entries(current)) {
    const before = baseline[name]

    if (before)
      rows.push({ name, current: now.min, baseline: before.min, changePercent: ((now.min - before.min) / before.min) * 100 })
  }

  return {
    rows,
    failed: rows.filter(r => r.changePercent > thresholdPercent),
    added: Object.keys(current).filter(name => !(name in baseline)),
    removed: Object.keys(baseline).filter(name => !(name in current)),
  }
}

/** Prints the comparison and returns whether the gate passed. */
export function reportGate(target: string, comparison: ReturnType<typeof compareToBaseline>, thresholdPercent: number): boolean {
  const width = Math.max(...comparison.rows.map(r => r.name.length), 9)

  console.log(`\n--- ${target} against its baseline (fails above +${thresholdPercent}%) ---\n`)
  console.log(`${'Benchmark'.padEnd(width)}  ${'Current'.padStart(11)}  ${'Baseline'.padStart(11)}  ${'Change'.padStart(8)}`)

  for (const row of comparison.rows) {
    const failed = row.changePercent > thresholdPercent
    const color = failed ? RED : row.changePercent <= -thresholdPercent ? GREEN : DIM
    const change = `${row.changePercent > 0 ? '+' : ''}${row.changePercent.toFixed(1)}%`

    console.log(`${row.name.padEnd(width)}  ${`${row.current.toFixed(4)}ms`.padStart(11)}  ${`${row.baseline.toFixed(4)}ms`.padStart(11)}  ${color}${change.padStart(8)}${failed ? ' !!' : ''}${RESET}`)
  }

  if (comparison.added.length > 0)
    console.log(`\nNot in the baseline, rerun with --update: ${comparison.added.join(', ')}`)

  if (comparison.removed.length > 0)
    console.log(`\nIn the baseline but not run, rerun with --update: ${comparison.removed.join(', ')}`)

  console.log(comparison.failed.length > 0 ? `\n${RED}${comparison.failed.length} benchmark(s) slower than the baseline by more than ${thresholdPercent}%${RESET}` : `\n${GREEN}within ${thresholdPercent}% of the baseline${RESET}`)

  return comparison.failed.length === 0
}
