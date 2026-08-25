import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

interface DesktopPaths {
  dataDir: string
  dshHome: string
  logsDir: string
  runtimeDir: string
}

/** Calls Rust-only desktop path adapter used by this focused host test. */
async function resolveDesktopPaths(input: {
  appData: string
  userHome: string
  sourceDshCli: string
}): Promise<DesktopPaths> {
  const { stdout } = await execFileAsync('cargo', [
    'run',
    '--quiet',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--',
    'resolve-desktop-paths',
    JSON.stringify(input),
  ], { cwd: new URL('..', import.meta.url) })
  return JSON.parse(stdout) as DesktopPaths
}

describe('desktop private state', () => {
  it('keeps desktop DSH state outside caller home', async () => {
    const fixtureAppData = 'C:/fixture/AppData/Local'
    const fixtureUserHome = 'C:/fixture/User'
    const paths = await resolveDesktopPaths({
      appData: fixtureAppData,
      userHome: fixtureUserHome,
      sourceDshCli: 'C:/fixture/dsh.ts',
    })

    expect(paths.dataDir.startsWith(fixtureAppData)).toBe(true)
    expect(paths.dshHome.startsWith(fixtureAppData)).toBe(true)
    expect(paths.dshHome.startsWith(fixtureUserHome)).toBe(false)
    expect(paths.logsDir.startsWith(paths.dataDir)).toBe(true)
    expect(paths.runtimeDir.startsWith(paths.dataDir)).toBe(true)
  })
})
