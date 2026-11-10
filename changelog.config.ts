import { defineConfig } from '@kaynooo/cli-changelog'

export default defineConfig({
  baseUrl: 'git.kaynooo.fr',
  rollup: { minor: true },
})
