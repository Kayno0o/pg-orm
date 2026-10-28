import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const HEADING = /^(#{2,3}) (.+)$/
const FENCE = /^(`{3,}|~{3,})/
const NOT_SLUG = /[^\p{L}\p{N}\- ]/gu

interface Heading { level: number, title: string, slug: string }

// The anchor GitHub and Forgejo give a heading: lowercased, punctuation dropped, spaces as dashes, a repeat suffixed `-1`, `-2`...
function slugger(): (title: string) => string {
  const seen = new Map<string, number>()

  return (title) => {
    const base = title.replaceAll('`', '').toLowerCase().replace(NOT_SLUG, '').replaceAll(' ', '-')
    const count = seen.get(base) ?? 0

    seen.set(base, count + 1)

    return count === 0 ? base : `${base}-${count}`
  }
}

function headings(readme: string): Heading[] {
  const slug = slugger()
  const found: Heading[] = []
  let fence: string | undefined

  for (const line of readme.split('\n')) {
    const marker = FENCE.exec(line)?.[1]

    if (marker && (!fence || marker.startsWith(fence))) {
      fence = fence ? undefined : marker

      continue
    }

    const match = fence ? null : HEADING.exec(line)

    if (match)
      found.push({ level: match[1]!.length, title: match[2]!, slug: slug(match[2]!) })
  }

  return found
}

/** `llms.txt` (what the library is, then a link to each README section) and `llms-full.txt` (the README itself), both derived from the README so neither drifts. */
export function renderLlms(readme: string, repository: string): Record<'llms.txt' | 'llms-full.txt', string> {
  const [title = '', ...rest] = readme.split('\n\n')
  const summary = rest.find(block => !block.startsWith('#')) ?? ''
  const base = `${repository}/src/branch/main/README.md`
  const links = headings(readme).map(h => `${h.level === 3 ? '  ' : ''}- [${h.title}](${base}#${h.slug})`)

  const llms = [
    title,
    `> ${summary.replaceAll('\n', ' ')}`,
    'Bun only. The whole reference is `llms-full.txt`, shipped beside this file in the package (`node_modules/@kaynooo/pg-orm/llms-full.txt`): read it instead of guessing an API, a column type or an option.',
    `## Docs\n\n${links.join('\n')}`,
  ].join('\n\n')

  return {
    'llms.txt': `${llms}\n`,
    'llms-full.txt': `<!-- Generated from README.md by scripts/llms.ts (bun run llms): edit the README, not this file. -->\n\n${readme}`,
  }
}

async function main(): Promise<void> {
  const readme = await Bun.file(join(ROOT, 'README.md')).text()
  const pkg = await Bun.file(join(ROOT, 'package.json')).json() as { repository: { url: string } }
  const files = renderLlms(readme, pkg.repository.url)

  for (const [name, content] of Object.entries(files))
    await Bun.write(join(ROOT, name), content)
}

if (import.meta.main)
  await main()
