import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Types ──

export interface BenchmarkResult {
  median: number
  p95: number
  min: number
  max: number
  opsPerSec: number
}

export interface RunResult {
  commit: string
  date: string
  suites: Record<string, BenchmarkResult>
}

export type BenchmarkFn = () => Promise<void> | void

export interface BenchmarkEntry {
  name: string
  fn: BenchmarkFn
  /** Fixed ops per iteration — skips calibration. Use for mutating benchmarks (inserts/deletes). */
  fixedOps?: number
}

// ── Timing ──

export function nowNs(): number {
  return Bun.nanoseconds()
}

export function nsToMs(ns: number): number {
  return ns / 1_000_000
}

// ── Statistics ──

function sorted(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b)
}

export function median(values: number[]): number {
  const s = sorted(values)
  const mid = Math.floor(s.length / 2)

  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

export function p95(values: number[]): number {
  const s = sorted(values)
  const idx = Math.ceil(0.95 * s.length) - 1

  return s[Math.max(0, idx)]!
}

export function min(values: number[]): number {
  return Math.min(...values)
}

export function max(values: number[]): number {
  return Math.max(...values)
}

// ── Runner ──

const WARMUP_ITERATIONS = 5
const MEASURE_ITERATIONS = 20

// Minimum time (ms) each iteration must run its inner loop.
// Longer = more ops per sample = less noise from single-op variance.
const MIN_ITERATION_MS = 200

/**
 * Calibrate how many ops fit in MIN_ITERATION_MS.
 * Starts at 1 and doubles until the target time is met.
 */
async function calibrate(fn: BenchmarkFn): Promise<number> {
  let ops = 1

  while (true) {
    const start = nowNs()

    for (let i = 0; i < ops; i++) await fn()
    const elapsed = nsToMs(nowNs() - start)

    if (elapsed >= MIN_ITERATION_MS)
      return ops

    // Scale up proportionally, with a floor of doubling
    ops = Math.max(ops * 2, Math.ceil(ops * (MIN_ITERATION_MS / Math.max(elapsed, 0.01))))
  }
}

export async function runBenchmark(entry: BenchmarkEntry): Promise<BenchmarkResult> {
  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    await entry.fn()
  }

  // Use fixed ops for mutating benchmarks, otherwise calibrate
  const ops = entry.fixedOps ?? await calibrate(entry.fn)

  // Measure
  const perOpTimes: number[] = []

  for (let i = 0; i < MEASURE_ITERATIONS; i++) {
    const start = nowNs()

    for (let j = 0; j < ops; j++) await entry.fn()
    perOpTimes.push(nsToMs(nowNs() - start) / ops)
  }

  const med = median(perOpTimes)

  return {
    median: med,
    p95: p95(perOpTimes),
    min: min(perOpTimes),
    max: max(perOpTimes),
    opsPerSec: med > 0 ? Math.round(1000 / med) : 0,
  }
}

// ── Result I/O ──

const RESULTS_DIR = join(import.meta.dir, 'results')

function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  }
  catch {
    return 'unknown'
  }
}

export function saveResult(result: RunResult): string {
  mkdirSync(RESULTS_DIR, { recursive: true })
  const filename = `${result.commit}.json`
  const filepath = join(RESULTS_DIR, filename)

  writeFileSync(filepath, JSON.stringify(result, null, 2))

  return filepath
}

export function loadPreviousResult(currentCommit: string): RunResult | null {
  if (!existsSync(RESULTS_DIR))
    return null

  const files = readdirSync(RESULTS_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith(currentCommit))
    .sort()

  if (files.length === 0)
    return null

  // Load the most recent result that isn't the current commit
  const filepath = join(RESULTS_DIR, files.at(-1)!)

  try {
    return JSON.parse(readFileSync(filepath, 'utf-8')) as RunResult
  }
  catch {
    return null
  }
}

export function buildRunResult(suites: Record<string, BenchmarkResult>): RunResult {
  return {
    commit: getCommitHash(),
    date: new Date().toISOString(),
    suites,
  }
}

// ── Comparison output ──

const RESET = '\x1B[0m'
const GREEN = '\x1B[32m'
const RED = '\x1B[31m'
const DIM = '\x1B[2m'

export function printComparison(current: RunResult, previous: RunResult): void {
  console.log('\n--- Comparison with previous run ---\n')

  const nameWidth = 35
  const colWidth = 12
  const header = [
    'Benchmark'.padEnd(nameWidth),
    'Current'.padStart(colWidth),
    'Previous'.padStart(colWidth),
    'Change'.padStart(colWidth),
  ].join('  ')

  console.log(header)
  console.log('-'.repeat(header.length))

  for (const [name, curr] of Object.entries(current.suites)) {
    const prev = previous.suites[name]

    if (!prev)
      continue

    const change = ((curr.median - prev.median) / prev.median) * 100
    const sign = change > 0 ? '+' : ''
    const changeStr = `${sign}${change.toFixed(1)}%`

    let color = DIM
    let marker = ''

    if (change <= -2) {
      color = GREEN
      marker = ' ok'
    }

    if (change >= 10) {
      color = RED
      marker = ' !!'
    }

    console.log([
      name.padEnd(nameWidth),
      `${curr.median.toFixed(2)}ms`.padStart(colWidth),
      `${prev.median.toFixed(2)}ms`.padStart(colWidth),
      `${color}${changeStr}${marker}${RESET}`.padStart(colWidth + color.length + RESET.length + marker.length),
    ].join('  '))
  }

  console.log()
}

// ── Suite helpers ──

export function defineSuite(name: string, benchmarks: BenchmarkEntry[]): { name: string, benchmarks: BenchmarkEntry[] } {
  return { name, benchmarks }
}

export function bench(name: string, fn: BenchmarkFn, opts?: { ops?: number }): BenchmarkEntry {
  return { name, fn, fixedOps: opts?.ops }
}
