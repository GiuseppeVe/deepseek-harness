/** Owned DSH web-backend lifecycle for the Electron main process. */

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { DesktopPaths } from './paths.ts'
import type { LeaseStore } from './lease.ts'

/** Fixed loopback hostname exposed to the sole Desktop window. */
export const DESKTOP_HOST = '127.0.0.1' as const
/** Fixed loopback port owned by one Desktop backend. */
export const DESKTOP_PORT = 3080 as const
/** Fixed URL loaded by the Electron renderer. */
export const DESKTOP_ORIGIN = `http://${DESKTOP_HOST}:${String(DESKTOP_PORT)}` as const

const READY_PATH = '/__dsh/ready'
const STATUS_PATH = '/__dsh/desktop/status'
const SHUTDOWN_PATH = '/__dsh/desktop/shutdown'
const LOG_TAIL_BYTES = 8 * 1024

/** A successful backend connection returned to Desktop main. */
export interface BackendReady {
  /** Fixed loopback origin for the desktop renderer. */
  origin: typeof DESKTOP_ORIGIN
}

/** Live work state observed through the authenticated Desktop control route. */
export type BackendStatus = 'idle' | 'active' | 'unavailable'

/** Owned child process operations needed by lifecycle supervision. */
export interface DesktopChild {
  /** Root PID for this child process tree. */
  pid: number
  /** Read a bounded backend diagnostic tail without environment data. */
  logTail(): string
  /** Subscribe to direct-child exit. */
  onExit(listener: (code: number | null) => void): () => void
}

/** Exact Electron-as-Node child invocation. */
export interface SpawnRequest {
  /** Electron's executable, not a host Node installation. */
  executable: string
  /** Staged DSH CLI entry and its web command arguments. */
  args: readonly string[]
  /** Child-only runtime environment including the control token. */
  env: NodeJS.ProcessEnv
}

/** Injectable side effects for source-level lifecycle tests. */
export interface BackendAdapter {
  /** Send one loopback control request. */
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** Spawn exactly one Electron-as-Node child. */
  spawn(request: SpawnRequest): DesktopChild
  /** Force one already authenticated owned process tree. */
  terminateTree(pid: number): Promise<void>
  /** Wait one bounded lifecycle interval. */
  wait(milliseconds: number): Promise<void>
  /** Read monotonic milliseconds for bounded polling. */
  now(): number
}

/** Deployment-selected paths and bounded lifecycle timeouts. */
export interface DesktopBackendConfig {
  /** Packaged Electron executable used as Node for the staged CLI. */
  electronExecutable: string
  /** Packaged DSH CLI entry. */
  cliEntry: string
  /** Final Desktop ownership patch passed after user layers. */
  patchPath: string
  /** Maximum readiness polling time after spawning DSH. */
  startTimeoutMs: number
  /** Grace period after authenticated shutdown before tree termination. */
  stopDeadlineMs: number
}

/** Constructor input for a source-level DSH backend supervisor. */
export interface DshBackendOptions {
  /** All mutable data paths owned by the current Windows user. */
  paths: DesktopPaths
  /** Authenticated prior-child proof storage. */
  lease: LeaseStore
  /** Prepare the user data root and its ACL before any mutable write. */
  prepareData(): Promise<void>
  /** Generate one opaque control token per fresh child. */
  createToken(): string
  /** Deployment paths and lifecycle bounds. */
  config: DesktopBackendConfig
  /** Injectable process, network, and time operations. */
  adapter: BackendAdapter
}

interface OwnedBackend {
  pid: number
  token: string
  child?: DesktopChild
}

/** Validate all timeout inputs before they reach polling or shutdown. */
function requirePositiveTimeout(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Desktop backend ${name} must be a positive finite number`)
}

/** Suppress credentials that could appear in a child diagnostic tail. */
function redactDiagnostic(text: string, token: string): string {
  return text
    .replaceAll(token, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, '$1[redacted]')
}

/** Build the only header allowed to carry Desktop's control credential. */
function controlHeaders(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` })
}

/** Owns one authenticated DSH child, never a generic port process. */
export class DshBackend {
  private owned: OwnedBackend | undefined
  private expectedExit = false
  private readonly unexpectedExitListeners = new Set<(code: number | null) => void>()

  /** Construct an idle supervisor with explicit process and timing dependencies. */
  constructor(private readonly options: DshBackendOptions) {
    requirePositiveTimeout('start timeout', options.config.startTimeoutMs)
    requirePositiveTimeout('stop deadline', options.config.stopDeadlineMs)
  }

  /** Start a new child or reattach only to a token-authenticated lease holder. */
  async start(): Promise<BackendReady> {
    if (this.owned !== undefined) return { origin: DESKTOP_ORIGIN }
    await this.options.prepareData()

    if (await this.isReady()) {
      const retained = await this.options.lease.read()
      if (retained !== undefined && await this.authenticate(retained.token)) {
        this.owned = { pid: retained.pid, token: retained.token }
        return { origin: DESKTOP_ORIGIN }
      }
      throw new Error(`DSH Desktop port conflict at ${DESKTOP_ORIGIN}`)
    }

    const token = this.options.createToken()
    const child = this.options.adapter.spawn({
      executable: this.options.config.electronExecutable,
      args: [
        this.options.config.cliEntry,
        'web',
        '--no-open',
        '--host',
        DESKTOP_HOST,
        '--port',
        String(DESKTOP_PORT),
        '--patch',
        this.options.config.patchPath,
      ],
      env: {
        ...process.env,
        DSH_HOME: this.options.paths.home,
        DSH_DESKTOP_CONTROL_TOKEN: token,
        ELECTRON_RUN_AS_NODE: '1',
      },
    })
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error('DSH Desktop backend child did not provide a positive PID')
    }
    this.expectedExit = false
    this.owned = { pid: child.pid, token, child }
    child.onExit((code) => { void this.handleChildExit(child.pid, code) })

    const deadline = this.options.adapter.now() + this.options.config.startTimeoutMs
    while (this.options.adapter.now() <= deadline) {
      if (await this.isReady() && await this.authenticate(token)) {
        await this.options.lease.write({ pid: child.pid, token })
        return { origin: DESKTOP_ORIGIN }
      }
      await this.options.adapter.wait(1)
    }

    await this.forceOwned(child.pid)
    this.owned = undefined
    const tail = redactDiagnostic(child.logTail().slice(-LOG_TAIL_BYTES), token)
    throw new Error(`DSH Desktop backend did not become ready before ${String(this.options.config.startTimeoutMs)}ms: ${tail}`)
  }

  /** Query aggregate work state through the authenticated local route. */
  async status(): Promise<BackendStatus> {
    const owned = this.owned
    if (owned === undefined) return 'unavailable'
    try {
      const response = await this.options.adapter.fetch(`${DESKTOP_ORIGIN}${STATUS_PATH}`, { headers: controlHeaders(owned.token) })
      if (!response.ok) return 'unavailable'
      const body = await response.json() as { activity?: unknown }
      if (body.activity === 'idle' || body.activity === 'active') return body.activity
      return 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  /** Request graceful stop, then terminate only an authenticated owned tree. */
  async stop(): Promise<void> {
    const owned = this.owned
    if (owned === undefined) return
    this.expectedExit = true
    try {
      await this.options.adapter.fetch(`${DESKTOP_ORIGIN}${SHUTDOWN_PATH}`, {
        method: 'POST',
        headers: controlHeaders(owned.token),
      })
    } catch {
      // The owned child may already be exiting; bounded termination remains required.
    }
    await this.options.adapter.wait(this.options.config.stopDeadlineMs)
    if (this.owned?.pid === owned.pid) await this.forceOwned(owned.pid)
    this.owned = undefined
    await this.options.lease.remove()
  }

  /** Stop and start one backend using the same user-owned data root and port. */
  async restart(): Promise<BackendReady> {
    await this.stop()
    this.expectedExit = false
    return await this.start()
  }

  /** Subscribe to crashes that keep the Electron window available for restart. */
  onUnexpectedExit(listener: (code: number | null) => void): () => void {
    this.unexpectedExitListeners.add(listener)
    return () => { this.unexpectedExitListeners.delete(listener) }
  }

  /** Probe the stable readiness route without interpreting a foreign response as healthy. */
  private async isReady(): Promise<boolean> {
    try {
      return (await this.options.adapter.fetch(`${DESKTOP_ORIGIN}${READY_PATH}`)).status === 204
    } catch {
      return false
    }
  }

  /** Prove a listener owns the exact token recorded or generated by Desktop. */
  private async authenticate(token: string): Promise<boolean> {
    try {
      const response = await this.options.adapter.fetch(`${DESKTOP_ORIGIN}${STATUS_PATH}`, { headers: controlHeaders(token) })
      if (!response.ok) return false
      const body = await response.json() as { activity?: unknown }
      return body.activity === 'idle' || body.activity === 'active'
    } catch {
      return false
    }
  }

  /** Force one selected child root only after its token was authenticated. */
  private async forceOwned(pid: number): Promise<void> {
    if (this.owned?.pid !== pid) return
    await this.options.adapter.terminateTree(pid)
  }

  /** Update exit state without presenting a requested shutdown as a crash. */
  private async handleChildExit(pid: number, code: number | null): Promise<void> {
    if (this.owned?.pid !== pid) return
    const expected = this.expectedExit
    this.owned = undefined
    await this.options.lease.remove()
    if (expected) return
    for (const listener of this.unexpectedExitListeners) listener(code)
  }
}

/** Generate a URL-safe control credential that never enters a CLI argument. */
export function createControlToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Run one Electron child as Node and retain only its last diagnostic bytes. */
function createNodeChild(request: SpawnRequest): DesktopChild {
  const process = spawn(request.executable, [...request.args], {
    env: request.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let tail = ''
  const append = (chunk: Buffer): void => {
    tail = `${tail}${chunk.toString('utf8')}`.slice(-LOG_TAIL_BYTES)
  }
  process.stdout?.on('data', append)
  process.stderr?.on('data', append)
  return {
    pid: process.pid ?? -1,
    logTail: () => tail,
    onExit(listener) {
      const onExit = (code: number | null): void => { listener(code) }
      process.once('exit', onExit)
      return () => { process.off('exit', onExit) }
    },
  }
}

/** Spawn `taskkill` for one child tree and wait only for the command to settle. */
function terminateWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      resolve()
      return
    }
    const command = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    command.once('error', () => { resolve() })
    command.once('close', () => { resolve() })
  })
}

/** Production process and loopback operations for Electron's Windows main process. */
export function createNodeBackendAdapter(): BackendAdapter {
  return {
    fetch: async (url, init) => await fetch(url, init),
    spawn: createNodeChild,
    terminateTree: terminateWindowsTree,
    wait: async milliseconds => await new Promise((resolve) => { setTimeout(resolve, milliseconds) }),
    now: () => Date.now(),
  }
}
