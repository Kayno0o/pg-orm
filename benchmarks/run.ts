import type { BenchmarkResult } from './utils'
import { createDb, seed } from './schema'
import { deleteSuite } from './suites/delete'
import { insertSuite } from './suites/insert'
import { paginationSuite } from './suites/pagination'
import { queryBuilderSuite } from './suites/query-builder'
import { relationsSuite } from './suites/relations'
import { selectSuite } from './suites/select'
import { updateSuite } from './suites/update'
import { buildRunResult, loadPreviousResult, printComparison, runBenchmark, saveResult } from './utils'

const RESET = '\x1B[0m'
const BOLD = '\x1B[1m'
const DIM = '\x1B[2m'
const CYAN = '\x1B[36m'

async function main() {
  console.log(`${BOLD}pg-orm benchmark suite${RESET}\n`)

  // ── Setup ──
  const db = createDb()

  console.log(`${DIM}Seeding database...${RESET}`)
  const counts = await seed(db, 1000, 5, 2)

  console.log(`  ${counts.userCount} users, ${counts.postCount} posts, ${counts.commentCount} comments\n`)

  // ── Collect suites ──
  const suites = [
    insertSuite(db),
    selectSuite(db),
    updateSuite(db),
    deleteSuite(db),
    relationsSuite(db),
    queryBuilderSuite(),
    paginationSuite(db),
  ]

  // ── Run ──
  const results: Record<string, BenchmarkResult> = {}

  for (const suite of suites) {
    console.log(`${CYAN}${BOLD}[${suite.name}]${RESET}`)

    for (const entry of suite.benchmarks) {
      const key = `${suite.name}.${entry.name}`

      process.stdout.write(`  ${entry.name} ... `)
      const result = await runBenchmark(entry)

      results[key] = result
      console.log(
        `${result.median.toFixed(2)}ms median  ${DIM}(p95: ${result.p95.toFixed(2)}ms, min: ${result.min.toFixed(2)}ms, max: ${result.max.toFixed(2)}ms, ${result.opsPerSec} ops/s)${RESET}`,
      )
    }

    console.log()
  }

  // ── Save & compare ──
  const runResult = buildRunResult(results)
  const filepath = saveResult(runResult)

  console.log(`${DIM}Results saved to ${filepath}${RESET}`)

  const previous = loadPreviousResult(runResult.commit)

  if (previous) {
    printComparison(runResult, previous)
  }

  // ── Cleanup ──
  await db.raw`DROP TABLE IF EXISTS bench_comments`
  await db.raw`DROP TABLE IF EXISTS bench_posts`
  await db.raw`DROP TABLE IF EXISTS bench_users`
  await db.close()
}

await main()
