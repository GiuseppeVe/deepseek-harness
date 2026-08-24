/** Built Web profile smoke: readiness probe settles before graceful disposal. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const builtBin = join(repoRoot, 'apps/cli/lib/bin.js')
const webDist = join(repoRoot, 'apps/web/dist/index.html')
const requireBuiltArtifacts = process.env.DSH_REQUIRE_BUILT_CLI_SMOKE === '1'

/** Boot built Web profile, probe readiness, then terminate through normal signal handling. */
function runReadinessSmoke(cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [
      builtBin,
      '--profile', 'web',
      '--no-open',
      '--host', '127.0.0.1',
      '--port', '0',
    ], {
      cwd,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'dsh-cli-readiness-dummy-key',
        DSH_HOME: join(cwd, '.dsh'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let probed = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (probed) return
      const match = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/u.exec(stdout)
      if (match?.[1] === undefined) return
      probed = true
      void fetch(`http://127.0.0.1:${match[1]}/__dsh/ready`).then((response) => {
        if (response.status !== 204) {
          throw new Error(`readiness probe returned ${String(response.status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
        }
        child.kill('SIGTERM')
      }).catch(rejectRun)
    })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectRun(new Error(`Web profile readiness smoke timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!probed) {
        rejectRun(new Error(`Web profile exited before readiness probe (code ${String(code)})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      resolveRun({ stdout, stderr, code: code ?? -1 })
    })
  })
}

describe.skipIf(!requireBuiltArtifacts)('desktop Web readiness', () => {
  it('returns 204 from the composed web profile before graceful disposal', async () => {
    expect(existsSync(builtBin), `missing built CLI ${resolve(builtBin)}; run pnpm build`).toBe(true)
    expect(existsSync(webDist), `missing Web dist ${resolve(webDist)}; run pnpm run build:web`).toBe(true)
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-cli-desktop-readiness-'))
    try {
      const result = await runReadinessSmoke(cwd)
      expect(result.code).toBe(0)
      expect(result.stdout).toMatch(/dsh web: http:\/\/127\.0\.0\.1:\d+/u)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 70_000)
})
