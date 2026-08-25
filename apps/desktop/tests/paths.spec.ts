import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
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
      'harden:C:/Users/A/AppData/Local/DSH Desktop',
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

    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
    const call = calls[0]!
    expect(call.command).toBe('powershell.exe')
    expect(call.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    expect(call.args.join(' ')).not.toContain(root)
    expect(call.env).toEqual({ DSH_DESKTOP_DATA_ROOT: `${root}/DSH Desktop` })
    const script = Buffer.from(call.args[5]!, 'base64').toString('utf16le')
    expect(script).toContain('WindowsIdentity]::GetCurrent().User')
    expect(script).toContain('ReparsePoint')
    expect(script).toContain('NtCreateFile')
    expect(script).toContain('NtQueryDirectoryFile')
    expect(script).toContain('RootDirectory = parent.DangerousGetHandle()')
    expect(script).not.toContain('DirectoryInfo')
    expect(script).not.toContain(root)
  })

  it.skipIf(process.platform !== 'win32')('resets a real temporary Windows data tree to the current SID', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-desktop-acl-'))
    const paths = resolveDesktopPaths(parent)
    try {
      await mkdir(join(paths.home, 'nested'), { recursive: true })
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$paths = @($env:DSH_DESKTOP_DATA_ROOT, (Join-Path $env:DSH_DESKTOP_DATA_ROOT 'nested'), (Join-Path $env:DSH_DESKTOP_DATA_ROOT 'nested\\state.json')); [void][IO.File]::WriteAllText($paths[2], 'seed'); $current = [Security.Principal.WindowsIdentity]::GetCurrent().User; $foreign = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null); foreach ($path in $paths) { $entry = Get-Item -LiteralPath $path -Force; $acl = $entry.GetAccessControl(); $acl.SetAccessRuleProtection($true, $false); [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($current, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)); [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($foreign, [Security.AccessControl.FileSystemRights]::ReadData, [Security.AccessControl.AccessControlType]::Allow)); [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($foreign, [Security.AccessControl.FileSystemRights]::WriteData, [Security.AccessControl.AccessControlType]::Deny)); $entry.SetAccessControl($acl) }",
      ], { env: { ...process.env, DSH_DESKTOP_DATA_ROOT: paths.home } })
      await prepareDesktopPaths(paths, createNodeWindowsDesktopPathAdapter())
      const result = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $items = @($env:DSH_DESKTOP_DATA_ROOT, (Join-Path $env:DSH_DESKTOP_DATA_ROOT 'nested'), (Join-Path $env:DSH_DESKTOP_DATA_ROOT 'nested\\state.json'), (Join-Path $env:DSH_DESKTOP_DATA_ROOT 'logs')); $valid = $true; foreach ($path in $items) { $acl = (Get-Item -LiteralPath $path -Force).GetAccessControl(); $rules = @($acl.Access); if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rules[0].IsInherited) { $valid = $false } }; if ($valid) { 'ok' } else { 'bad' }",
      ], { env: { ...process.env, DSH_DESKTOP_DATA_ROOT: paths.home } })
      expect(result.stdout.trim()).toBe('ok')
    } finally {
      await execFileAsync('icacls.exe', [parent, '/reset', '/T', '/C'], { windowsHide: true })
      await rm(parent, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('rejects a nested junction before touching its target', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-desktop-reparse-'))
    const paths = resolveDesktopPaths(parent)
    const outside = join(parent, 'outside')
    const junction = join(paths.home, 'nested', 'foreign-link')
    try {
      await mkdir(outside)
      await mkdir(paths.home, { recursive: true })
      await mkdir(join(paths.home, 'nested'))
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$entry = Get-Item -LiteralPath $env:DSH_DESKTOP_OUTSIDE -Force; $foreign = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null); $acl = $entry.GetAccessControl(); [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($foreign, [Security.AccessControl.FileSystemRights]::ReadData, [Security.AccessControl.AccessControlType]::Allow)); $entry.SetAccessControl($acl)',
      ], { env: { ...process.env, DSH_DESKTOP_OUTSIDE: outside } })
      await symlink(outside, junction, 'junction')

      await expect(prepareDesktopPaths(paths, createNodeWindowsDesktopPathAdapter())).rejects.toThrow('Desktop data ACL setup failed')

      const result = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$foreign = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null).Value; $rules = @((Get-Item -LiteralPath $env:DSH_DESKTOP_OUTSIDE -Force).GetAccessControl().Access); if ($rules.IdentityReference | ForEach-Object { $_.Translate([Security.Principal.SecurityIdentifier]).Value } | Where-Object { $_ -eq $foreign }) { 'ok' } else { 'bad' }",
      ], { env: { ...process.env, DSH_DESKTOP_OUTSIDE: outside } })
      expect(result.stdout.trim()).toBe('ok')
    } finally {
      await rm(junction, { force: true, recursive: false })
      await execFileAsync('icacls.exe', [parent, '/reset', '/T', '/C'], { windowsHide: true })
      await rm(parent, { recursive: true, force: true })
    }
  })
})
