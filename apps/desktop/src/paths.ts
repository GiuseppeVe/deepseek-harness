/** Mutable filesystem locations and fail-closed Windows DACL setup for DSH Desktop. */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'

/** Every mutable path owned by one Windows user's DSH Desktop installation. */
export interface DesktopPaths {
  /** DSH home passed to the owned backend process. */
  home: string
  /** User-owned credentials file. */
  env: string
  /** Bounded backend-log directory. */
  logs: string
  /** Authenticated owned-backend lease. */
  lease: string
}

/** Injectable data-root operations. */
export interface DesktopPathAdapter {
  /** Create one directory and its missing parents. */
  mkdir(path: string): Promise<void>
  /** Reject reparse points and reset the existing root tree to the current SID. */
  hardenTree(path: string): Promise<void>
}

/** Injectable fixed PowerShell runner for Windows DACL application. */
export interface WindowsDesktopPathAdapterOptions {
  /** Create Desktop directories. */
  mkdir(path: string): Promise<void>
  /** Run one fixed executable without constructing a command string. */
  run(
    command: 'powershell.exe',
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<void>
}

/** Resolve Desktop's mutable files below the caller's LocalAppData directory. */
export function resolveDesktopPaths(localAppData: string): DesktopPaths {
  const home = `${localAppData.replace(/[\\/]+$/, '')}/DSH Desktop`
  return {
    home,
    env: `${home}/.env`,
    logs: `${home}/logs`,
    lease: `${home}/backend.lease.json`,
  }
}

/** Fixed PowerShell body; root travels only through its process environment value. */
const RESET_DESKTOP_DACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$root = [Environment]::GetEnvironmentVariable('DSH_DESKTOP_DATA_ROOT', 'Process')
if ([string]::IsNullOrWhiteSpace($root)) { throw 'DSH Desktop data root is missing' }
$rootItem = Get-Item -LiteralPath $root -Force
if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'DSH Desktop data root is a reparse point' }
$reparse = @(Get-ChildItem -LiteralPath $root -Force -Recurse -Attributes ReparsePoint)
if ($reparse.Count -ne 0) { throw 'DSH Desktop data tree contains a reparse point' }
$items = @($rootItem) + @(Get-ChildItem -LiteralPath $root -Force -Recurse)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($item in $items) {
  if ($item.PSIsContainer) {
    $entry = [System.IO.DirectoryInfo]$item.FullName
  } else {
    $entry = [System.IO.FileInfo]$item.FullName
  }
  $acl = $entry.GetAccessControl()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
  if ($item.PSIsContainer) {
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
  $entry.SetAccessControl($acl)
}
`

/** Encode a static PowerShell program for noninteractive execution. */
function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Create Desktop's data root, secure its existing tree, then create mutable descendants. */
export async function prepareDesktopPaths(paths: DesktopPaths, adapter: DesktopPathAdapter): Promise<void> {
  await adapter.mkdir(paths.home)
  try {
    await adapter.hardenTree(paths.home)
  } catch {
    throw new Error('Desktop data ACL setup failed')
  }
  await adapter.mkdir(paths.logs)
}

/** Create an adapter whose root stays out of PowerShell arguments and source text. */
export function createWindowsDesktopPathAdapter(options: WindowsDesktopPathAdapterOptions): DesktopPathAdapter {
  return {
    mkdir: options.mkdir,
    async hardenTree(path: string): Promise<void> {
      await options.run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedPowerShell(RESET_DESKTOP_DACL_SCRIPT),
      ], { DSH_DESKTOP_DATA_ROOT: path })
    },
  }
}

/** Default directory creator for Electron's Windows-only main process. */
export const nodeDesktopPathAdapter: Pick<DesktopPathAdapter, 'mkdir'> = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }) },
}

const execFileAsync = promisify(execFile)

/** Production Windows adapter that resets every existing data-tree DACL before descendant writes. */
export function createNodeWindowsDesktopPathAdapter(): DesktopPathAdapter {
  return createWindowsDesktopPathAdapter({
    ...nodeDesktopPathAdapter,
    run: async (command, args, env) => {
      await execFileAsync(command, [...args], { env: { ...process.env, ...env }, windowsHide: true })
    },
  })
}
