import { describe, expect, it } from 'bun:test'
import { mapEveryCoercion } from '../../helpers/map-every-coercion'

const HELPER = new URL('../../helpers/map-every-coercion.ts', import.meta.url).pathname

describe('with code generation from strings disallowed', () => {
  it('maps every coerced column, a pick and a computed alias as the compiled mapper does', async () => {
    const script = `import { mapEveryCoercion } from ${JSON.stringify(HELPER)}\nconsole.log(await mapEveryCoercion())`
    const child = Bun.spawn([process.execPath, '--disallow-code-generation-from-strings', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out.trim()).toBe(await mapEveryCoercion())
  })
})
