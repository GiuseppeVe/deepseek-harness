import { describe, expect, it } from 'vitest'
import { createWindowsDesktopPathAdapter, prepareDesktopPaths, resolveDesktopPaths } from '../src/paths.ts'

describe('Desktop paths', () => {
  it('keeps mutable data below LocalAppData instead of installation paths', () => {
    expect(resolveDesktopPaths('C:/Users/A/AppData/Local')).toEqual({
      home: 'C:/Users/A/AppData/Local/DSH Desktop',
      env: 'C:/Users/A/AppData/Local/DSH Desktop/.env',
      logs: 'C:/Users/A/AppData/Local/DSH Desktop/logs',
      lease: 'C:/Users/A/AppData/Local/DSH Desktop/backend.lease.json',
    })
  })

  it('creates and restricts data root before mutable descendants', async () => {
    const calls: string[] = []
    const paths = resolveDesktopPaths('C:/Users/A/AppData/Local')

    await prepareDesktopPaths(paths, {
      mkdir: async (path) => { calls.push(`mkdir:${path}`) },
      currentUser: async () => 'DESKTOP-1\\A',
      restrictToCurrentUser: async (path, user) => { calls.push(`acl:${path}:${user}`) },
    })

    expect(calls).toEqual([
      'mkdir:C:/Users/A/AppData/Local/DSH Desktop',
      'acl:C:/Users/A/AppData/Local/DSH Desktop:DESKTOP-1\\A',
      'mkdir:C:/Users/A/AppData/Local/DSH Desktop/logs',
    ])
  })

  it('fails before descendant writes when current-user ACL setup fails', async () => {
    const paths = resolveDesktopPaths('C:/Users/A/AppData/Local')
    const mkdir = async () => {}

    await expect(prepareDesktopPaths(paths, {
      mkdir,
      currentUser: async () => 'DESKTOP-1\\A',
      restrictToCurrentUser: async () => { throw new Error('icacls failed') },
    })).rejects.toThrow('Desktop data ACL')
  })

  it('rejects an unsafe current-user target before invoking ACL tooling', async () => {
    const paths = resolveDesktopPaths('C:/Users/A/AppData/Local')
    let aclCalled = false

    await expect(prepareDesktopPaths(paths, {
      mkdir: async () => {},
      currentUser: async () => 'A /grant Everyone:F',
      restrictToCurrentUser: async () => { aclCalled = true },
    })).rejects.toThrow('current Windows user')

    expect(aclCalled).toBe(false)
  })

  it('runs icacls only with the validated current Windows user', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const adapter = createWindowsDesktopPathAdapter({
      mkdir: async () => {},
      currentUser: async () => 'DESKTOP-1\\A',
      run: async (command, args) => { calls.push({ command, args }) },
    })

    await prepareDesktopPaths(resolveDesktopPaths('C:/Users/A/AppData/Local'), adapter)

    expect(calls).toEqual([{
      command: 'icacls',
      args: [
        'C:/Users/A/AppData/Local/DSH Desktop',
        '/inheritance:r',
        '/grant:r',
        'DESKTOP-1\\A:(OI)(CI)F',
      ],
    }])
  })
})
