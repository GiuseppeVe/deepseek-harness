import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createNodeWindowsDesktopPathAdapter, createWindowsDesktopPathAdapter, prepareDesktopPaths, resolveDesktopPaths } from '../src/paths.ts'

const execFileAsync = promisify(execFile)

describe('Desktop paths', () => {
  it('keeps mutable data below LocalAppData instead of installation paths', () => {
    expect(resolveDesktopPaths('C:/Users/A/AppData/Local')).toEqual({
      home: 'C:/Users/A/AppData/Local/DSH Desktop',
      env: 'C:/Users/A/AppData/Local/DSH Desktop/.env',
      logs: 'C:/Users/A/AppData/Local/DSH Desktop/logs',
      lease: 'C:/Users/A/AppData/Local/DSH Desktop/backend.lease.json',
    })
  })

  it('hardens the entire data tree before mutable descendant writes', async () => {
    const calls: string[] = []
    const paths = resolveDesktopPaths('C:/Users/A/AppData/Local')

    await prepareDesktopPaths(paths, {
      mkdir: async (path) => { calls.push(`mkdir:${path}`) },
      hardenTree: async (path) => { calls.push(`harden:${path}`) },
    })

    expect(calls).toEqual([
      'mkdir:C:/Users/A/AppData/Local/DSH Desktop',
      'harden:C:/Users/A/AppData/Local/DSH Desktop',
      'mkdir:C:/Users/A/AppData/Local/DSH Desktop/logs',
    ])
  })

  it('fails closed before descendant writes when data-tree hardening fails', async () => {
    const calls: string[] = []
    const paths = resolveDesktopPaths('C:/Users/A/AppData/Local')

    await expect(prepareDesktopPaths(paths, {
      mkdir: async (path) => { calls.push(path) },
      hardenTree: async () => { throw new Error('reparse point found') },
    })).rejects.toThrow('Desktop data ACL')

    expect(calls).toEqual([paths.home])
  })

  it('uses fixed encoded PowerShell and passes an unsafe root only through process environment', async () => {
    const calls: Array<{ command: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> }> = []
    const root = 'C:/Users/A/AppData/Local/DSH Desktop; Write-Error injected'
    const adapter = createWindowsDesktopPathAdapter({
      mkdir: async () => {},
      run: async (command, args, env) => { calls.push({ command, args, env }) },
    })

    await prepareDesktopPaths(resolveDesktopPaths(root), adapter)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.command).toBe('powershell.exe')
    expect(call.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    expect(call.args.join(' ')).not.toContain(root)
    expect(call.env).toEqual({ DSH_DESKTOP_DATA_ROOT: `${root}/DSH Desktop` })
    const script = Buffer.from(call.args[5]!, 'base64').toString('utf16le')
    expect(script).toContain('WindowsIdentity]::GetCurrent().User')
    expect(script).toContain('ReparsePoint')
    expect(script).not.toContain(root)
  })

  it.skipIf(process.platform !== 'win32')('resets a real temporary Windows data tree to the current SID', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-desktop-acl-'))
    const paths = resolveDesktopPaths(parent)
    try {
      await prepareDesktopPaths(paths, createNodeWindowsDesktopPathAdapter())
      const result = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$entry = [System.IO.DirectoryInfo]$env:DSH_DESKTOP_DATA_ROOT; $acl = $entry.GetAccessControl(); $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' }); $sddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access); if ($rules.Count -eq 1 -and $sddl.Contains($sid)) { 'ok' } else { 'bad' }",
      ], { env: { ...process.env, DSH_DESKTOP_DATA_ROOT: paths.home } })
      expect(result.stdout.trim()).toBe('ok')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
