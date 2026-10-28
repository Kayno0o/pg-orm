import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { renderLlms } from '../../scripts/llms'

const ROOT = join(import.meta.dir, '../..')

describe('llms.txt', () => {
  it('matches the README: run `bun run llms` after editing it', async () => {
    const readme = await Bun.file(join(ROOT, 'README.md')).text()
    const pkg = await Bun.file(join(ROOT, 'package.json')).json() as { repository: { url: string } }

    for (const [name, content] of Object.entries(renderLlms(readme, pkg.repository.url)))
      expect(await Bun.file(join(ROOT, name)).text(), name).toBe(content)
  })

  it('links each section by the anchor the forge renders, outside code fences', () => {
    const readme = '# lib\n\nWhat it is.\n\n## Eager Loading (No N+1)\n\n```bash\n## not a heading\n```\n\n### `defineTable` and JOINs, CTEs\n\n## Eager Loading (No N+1)\n'
    const { 'llms.txt': llms } = renderLlms(readme, 'https://forge/x')

    expect(llms.split('\n\n')).toEqual([
      '# lib',
      '> What it is.',
      expect.any(String),
      '## Docs',
      '- [Eager Loading (No N+1)](https://forge/x/src/branch/main/README.md#eager-loading-no-n1)\n  - [`defineTable` and JOINs, CTEs](https://forge/x/src/branch/main/README.md#definetable-and-joins-ctes)\n- [Eager Loading (No N+1)](https://forge/x/src/branch/main/README.md#eager-loading-no-n1-1)\n',
    ])
  })
})
