/** Mutable filesystem locations and ACL setup for DSH Desktop. */

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

/** Injectable current-user ACL operations. */
export interface DesktopPathAdapter {
  /** Create one directory and its missing parents. */
  mkdir(path: string): Promise<void>
  /** Resolve Windows identity for ACL targeting. */
  currentUser(): Promise<string>
  /** Restrict a directory to the resolved current Windows user. */
  restrictToCurrentUser(path: string, user: string): Promise<void>
}

/** Injectable command runner for Windows account lookup and ACL application. */
export interface WindowsDesktopPathAdapterOptions {
  /** Create Desktop directories. */
  mkdir(path: string): Promise<void>
  /** Return the current Windows `DOMAIN\\user` identity. */
  currentUser(): Promise<string>
  /** Run one fixed Windows executable with separately provided arguments. */
  run(command: 'icacls', args: readonly string[]): Promise<void>
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

/** Reject identity text that could escape the one-user `icacls` argument. */
function isCurrentWindowsUser(user: string): boolean {
  return /^[^\\/:*?"<>|\r\n]+\\[^\\/:*?"<>|\r\n]+$/.test(user)
}

/** Create Desktop's data root, apply its ACL, then create log storage. */
export async function prepareDesktopPaths(paths: DesktopPaths, adapter: DesktopPathAdapter): Promise<void> {
  await adapter.mkdir(paths.home)
  const user = await adapter.currentUser()
  if (!isCurrentWindowsUser(user)) throw new Error('Desktop data ACL requires a current Windows user in DOMAIN\\user form')
  try {
    await adapter.restrictToCurrentUser(paths.home, user)
  } catch {
    throw new Error('Desktop data ACL setup failed')
  }
  await adapter.mkdir(paths.logs)
}

/** Create a Windows ACL adapter that grants only the validated current user. */
export function createWindowsDesktopPathAdapter(options: WindowsDesktopPathAdapterOptions): DesktopPathAdapter {
  return {
    mkdir: options.mkdir,
    currentUser: options.currentUser,
    async restrictToCurrentUser(path: string, user: string): Promise<void> {
      if (!isCurrentWindowsUser(user)) throw new Error('Desktop data ACL requires a current Windows user in DOMAIN\\user form')
      await options.run('icacls', [path, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`])
    },
  }
}

/** Default directory creator for Electron's Windows-only main process. */
export const nodeDesktopPathAdapter: Pick<DesktopPathAdapter, 'mkdir'> = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }) },
}

const execFileAsync = promisify(execFile)

/** Production Windows ACL adapter; command failures reject before mutable writes continue. */
export function createNodeWindowsDesktopPathAdapter(): DesktopPathAdapter {
  return createWindowsDesktopPathAdapter({
    ...nodeDesktopPathAdapter,
    currentUser: async () => (await execFileAsync('whoami')).stdout.trim(),
    run: async (command, args) => { await execFileAsync(command, [...args]) },
  })
}
