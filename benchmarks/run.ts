import type { BenchmarkResult } from './utils'
import { parseArgs } from 'node:util'
import { compareToBaseline, DEFAULT_THRESHOLD_PERCENT, loadBaseline, reportGate, saveBaseline } from './gate'
import { targets } from './targets'
import { buildRunResult, loadPreviousResult, printComparison, runBenchmark, saveResult } from './utils'

const RESET = '\x1B[0m'
const BOLD = '\x1B[1m'
const DIM = '\x1B[2m'
const CYAN = '\x1B[36m'

const USAGE = `Usage: bun run benchmarks/run.ts [target...] [--gate] [--update] [--threshold <percent>]

Targets: ${Object.keys(targets).join(', ')}. Without one, runs pg, or with --gate the targets with no database to start: repo, sqlite.
--gate        compare each result with benchmarks/baselines/<target>.json and exit 1 when one is slower by more than the threshold (default ${DEFAULT_THRESHOLD_PERCENT}%)
--update      with --gate, write the results as the new baseline instead of comparing`

/** Runs one target's suites and returns the results, keyed `<suite>.<benchmark>`. */
async function runTarget(name: string): Promise<Record<string, BenchmarkResult>> {
  const load = targets[name]

  if (!load)
    throw new Error(`Unknown target "${name}". ${USAGE}`)

  const { suites, close } = await load()
  const results: Record<string, BenchmarkResult> = {}

  try {
    for (const suite of suites) {
      console.log(`${CYAN}${BOLD}[${suite.name}]${RESET}`)

      for (const entry of suite.benchmarks) {
        process.stdout.write(`  ${entry.name} ... `)
        const result = await runBenchmark(entry)

        results[`${suite.name}.${entry.name}`] = result
        console.log(
          `${result.median.toFixed(4)}ms median  ${DIM}(p95: ${result.p95.toFixed(4)}ms, min: ${result.min.toFixed(4)}ms, max: ${result.max.toFixed(4)}ms, ${result.opsPerSec} ops/s)${RESET}`,
        )
      }

      console.log()
    }
  }
  finally {
    await close()
  }

  return results
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      gate: { type: 'boolean', default: false },
      update: { type: 'boolean', default: false },
      threshold: { type: 'string', default: String(DEFAULT_THRESHOLD_PERCENT) },
      help: { type: 'boolean', default: false },
    },
  })

  if (values.help) {
    console.log(USAGE)

    return 0
  }

  const threshold = Number(values.threshold)

  if (!Number.isFinite(threshold) || threshold <= 0)
    throw new Error(`--threshold must be a positive number, got "${values.threshold}"`)

  const names = positionals.length > 0 ? positionals : values.gate ? ['repo', 'sqlite'] : ['pg']
  let passed = true

  console.log(`${BOLD}pg-orm benchmark suite${RESET}\n`)

  for (const name of names) {
    const results = await runTarget(name)
    const runResult = buildRunResult(results)

    if (values.gate && values.update) {
      console.log(`${DIM}Baseline saved to ${saveBaseline(name, runResult)}${RESET}\n`)

      continue
    }

    console.log(`${DIM}Results saved to ${saveResult(runResult, name)}${RESET}`)

    if (values.gate) {
      const baseline = loadBaseline(name)

      if (!baseline) {
        console.log(`No baseline for ${name}: run with --gate --update to record one.`)
        passed = false

        continue
      }

      passed = reportGate(name, compareToBaseline(results, baseline.suites, threshold), threshold) && passed

      continue
    }

    const previous = loadPreviousResult(name, runResult.commit)

    if (previous)
      printComparison(runResult, previous)
  }

  return passed ? 0 : 1
}

process.exit(await main())
