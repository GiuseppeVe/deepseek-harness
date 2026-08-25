/** Owned DSH web-backend lifecycle for the Electron main process. */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import type { BackendIdentity, LeaseStore } from './lease.ts'
import type { DesktopPaths } from './paths.ts'

/** Fixed loopback hostname exposed to the sole Desktop window. */
export const DESKTOP_HOST = '127.0.0.1' as const
/** Fixed loopback port owned by one Desktop backend. */
export const DESKTOP_PORT = 3080 as const
/** Fixed URL loaded by the Electron renderer. */
export const DESKTOP_ORIGIN = `http://${DESKTOP_HOST}:${String(DESKTOP_PORT)}` as const

const READY_PATH = '/__dsh/ready'
const STATUS_PATH = '/__dsh/desktop/status'
const IDENTITY_PATH = '/__dsh/desktop/identity'
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
  /** Probe TCP occupancy; only an explicit refusal reports a free port. */
  probeLoopback(): Promise<'free' | 'occupied'>
  /** Read a live process creation FILETIME, or report no current process. */
  creationFiletime(pid: number): Promise<string | undefined>
  /** Spawn exactly one Electron-as-Node child. */
  spawn(request: SpawnRequest): DesktopChild
  /** Force one process tree only after the caller proves this full identity. */
  terminateTree(identity: BackendIdentity): Promise<void>
  /** Schedule a bounded periodic identity check and return its disposer. */
  monitor(milliseconds: number, task: () => void): () => void
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
  /** Bounded interval used only to verify a reattached backend remains exact. */
  reattachMonitorMs: number
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
  identity: BackendIdentity
  token: string
  child?: DesktopChild
}

/** Validate all timeout inputs before they reach polling, monitoring, or shutdown. */
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

/** Check an identity value before it can authorize a force termination. */
function isBackendIdentity(value: unknown): value is BackendIdentity {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return Number.isSafeInteger(record.pid)
    && (record.pid as number) > 0
    && typeof record.nonce === 'string'
    && /^[A-Za-z0-9_-]{32,}$/.test(record.nonce)
    && typeof record.creationFiletime === 'string'
    && /^[1-9][0-9]{16,19}$/.test(record.creationFiletime)
}

/** Compare all fields used to distinguish PID reuse from an owned backend. */
function isSameIdentity(left: BackendIdentity, right: BackendIdentity): boolean {
  return left.pid === right.pid
    && left.nonce === right.nonce
    && left.creationFiletime === right.creationFiletime
}

/** Owns one authenticated DSH child, never a generic port process. */
export class DshBackend {
  private owned: OwnedBackend | undefined
  private expectedExit = false
  private monitorDisposer: (() => void) | undefined
  private monitorInspecting = false
  private lifecycle: Promise<void> = Promise.resolve()
  private readonly unexpectedExitListeners = new Set<(code: number | null) => void>()

  /** Construct an idle supervisor with explicit process and timing dependencies. */
  constructor(private readonly options: DshBackendOptions) {
    requirePositiveTimeout('start timeout', options.config.startTimeoutMs)
    requirePositiveTimeout('stop deadline', options.config.stopDeadlineMs)
    requirePositiveTimeout('reattach monitor interval', options.config.reattachMonitorMs)
  }

  /** Start a new child or reattach only to an exact authenticated lease holder. */
  async start(): Promise<BackendReady> {
    return await this.serialize(async () => await this.startInternal())
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

  /** Request graceful stop, then force only an exact currently authenticated identity. */
  async stop(): Promise<void> {
    await this.serialize(async () => await this.stopInternal())
  }

  /** Stop and start one backend using the same user-owned data root and port. */
  async restart(): Promise<BackendReady> {
    return await this.serialize(async () => {
      await this.stopInternal()
      this.expectedExit = false
      return await this.startInternal()
    })
  }

  /** Subscribe to failures that keep the Electron window available for native recovery. */
  onUnexpectedExit(listener: (code: number | null) => void): () => void {
    this.unexpectedExitListeners.add(listener)
    return () => { this.unexpectedExitListeners.delete(listener) }
  }

  /** Serialize lifecycle transitions while allowing status reads to remain nonblocking. */
  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(operation, operation)
    this.lifecycle = run.then(() => undefined, () => undefined)
    return await run
  }

  /** Start a backend after the caller owns the serialized lifecycle transition. */
  private async startInternal(): Promise<BackendReady> {
    if (this.owned !== undefined) return { origin: DESKTOP_ORIGIN }
    await this.options.prepareData()

    if (await this.options.adapter.probeLoopback() === 'occupied') {
      const retained = await this.options.lease.read()
      if (retained !== undefined && await this.isReady()) {
        const observed = await this.authenticatedIdentity(retained.token, retained.pid)
        if (observed !== undefined && isSameIdentity(observed, retained)) {
          const reattached: OwnedBackend = { identity: retained, token: retained.token }
          this.owned = reattached
          this.expectedExit = false
          this.monitorReattached(reattached)
          return { origin: DESKTOP_ORIGIN }
        }
      }
      throw this.portConflict()
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
    let childExited = false
    child.onExit(() => { childExited = true })

    const deadline = this.options.adapter.now() + this.options.config.startTimeoutMs
    while (this.options.adapter.now() <= deadline && !childExited) {
      if (await this.isReady()) {
        const identity = await this.authenticatedIdentity(token, child.pid)
        if (identity !== undefined) {
          const fresh: OwnedBackend = { identity, token, child }
          this.owned = fresh
          this.expectedExit = false
          child.onExit((code) => { void this.serialize(async () => await this.handleChildExit(fresh, code)) })
          try {
            await this.options.lease.write({ ...identity, token })
          } catch (error) {
            try {
              await this.forceOwned(fresh)
            } finally {
              this.owned = undefined
            }
            throw error
          }
          return { origin: DESKTOP_ORIGIN }
        }
      }
      await this.options.adapter.wait(1)
    }

    const tail = redactDiagnostic(child.logTail().slice(-LOG_TAIL_BYTES), token)
    throw new Error(`DSH Desktop backend did not become ready before ${String(this.options.config.startTimeoutMs)}ms: ${tail}`)
  }

  /** Stop an authenticated identity after the caller owns the serialized lifecycle transition. */
  private async stopInternal(): Promise<void> {
    const owned = this.owned
    if (owned === undefined) return
    this.expectedExit = true
    this.stopMonitor()
    try {
      await this.options.adapter.fetch(`${DESKTOP_ORIGIN}${SHUTDOWN_PATH}`, {
        method: 'POST',
        headers: controlHeaders(owned.token),
      })
    } catch {
      // The authenticated backend may already be exiting; identity proof still gates force termination.
    }
    await this.options.adapter.wait(this.options.config.stopDeadlineMs)
    try {
      if (this.owned === owned) await this.forceOwned(owned)
    } finally {
      if (this.owned === owned) this.owned = undefined
      await this.options.lease.remove()
    }
  }

  /** Probe the stable readiness route without interpreting a foreign response as healthy. */
  private async isReady(): Promise<boolean> {
    try {
      return (await this.options.adapter.fetch(`${DESKTOP_ORIGIN}${READY_PATH}`)).status === 204
    } catch {
      return false
    }
  }

  /** Authenticate one control route, bind it to the live process FILETIME, and optionally require a PID. */
  private async authenticatedIdentity(token: string, requiredPid?: number): Promise<BackendIdentity | undefined> {
    try {
      const response = await this.options.adapter.fetch(`${DESKTOP_ORIGIN}${IDENTITY_PATH}`, { headers: controlHeaders(token) })
      if (!response.ok) return undefined
      const body = await response.json() as { pid?: unknown; nonce?: unknown }
      if (!Number.isSafeInteger(body.pid) || (body.pid as number) <= 0 || typeof body.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(body.nonce)) return undefined
      if (requiredPid !== undefined && body.pid !== requiredPid) return undefined
      const creationFiletime = await this.options.adapter.creationFiletime(body.pid as number)
      const identity = { pid: body.pid as number, nonce: body.nonce, creationFiletime }
      return isBackendIdentity(identity) ? identity : undefined
    } catch {
      return undefined
    }
  }

  /** Force only an owned identity that still authenticates and has the same Windows FILETIME. */
  private async forceOwned(owned: OwnedBackend): Promise<void> {
    if (this.owned !== owned) return
    const observed = await this.authenticatedIdentity(owned.token, owned.identity.pid)
    if (observed === undefined || !isSameIdentity(observed, owned.identity)) throw this.portConflict()
    await this.options.adapter.terminateTree(owned.identity)
  }

  /** Poll an externally reattached backend without treating it as a direct child. */
  private monitorReattached(owned: OwnedBackend): void {
    this.stopMonitor()
    this.monitorDisposer = this.options.adapter.monitor(this.options.config.reattachMonitorMs, () => {
      if (this.monitorInspecting) return
      this.monitorInspecting = true
      void this.serialize(async () => {
        try {
          if (this.owned !== owned) return
          const observed = await this.authenticatedIdentity(owned.token, owned.identity.pid)
          if (observed === undefined || !isSameIdentity(observed, owned.identity)) await this.markUnavailable(owned, null)
        } finally {
          this.monitorInspecting = false
        }
      })
    })
  }

  /** Stop a reattach-only identity monitor before changing ownership. */
  private stopMonitor(): void {
    this.monitorDisposer?.()
    this.monitorDisposer = undefined
    this.monitorInspecting = false
  }

  /** Update direct-child exit state without presenting a requested shutdown as a crash. */
  private async handleChildExit(owned: OwnedBackend, code: number | null): Promise<void> {
    if (this.owned !== owned) return
    await this.markUnavailable(owned, code)
  }

  /** Clear an invalid or exited identity without ever terminating an unproven process. */
  private async markUnavailable(owned: OwnedBackend, code: number | null): Promise<void> {
    if (this.owned !== owned) return
    const expected = this.expectedExit
    this.stopMonitor()
    this.owned = undefined
    await this.options.lease.remove()
    if (expected) return
    for (const listener of this.unexpectedExitListeners) listener(code)
  }

  /** Build one non-sensitive conflict error for any foreign or mismatched listener. */
  private portConflict(): Error {
    return new Error(`DSH Desktop port conflict at ${DESKTOP_ORIGIN}`)
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

/** Treat only a refused loopback TCP connection as free; all other outcomes are occupied. */
function probeLoopbackTcp(): Promise<'free' | 'occupied'> {
  return new Promise((resolve) => {
    const socket = connect(DESKTOP_PORT, DESKTOP_HOST)
    let settled = false
    const finish = (result: 'free' | 'occupied'): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => { finish('occupied') })
    socket.once('timeout', () => { finish('occupied') })
    socket.once('error', (error: NodeJS.ErrnoException) => { finish(error.code === 'ECONNREFUSED' ? 'free' : 'occupied') })
    socket.setTimeout(1_000)
  })
}

/** Spawn `taskkill` for one proven child tree and wait only for the command to settle. */
function terminateWindowsTree(identity: BackendIdentity): Promise<void> {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) {
      resolve()
      return
    }
    const command = spawn('taskkill', ['/PID', String(identity.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    command.once('error', () => { resolve() })
    command.once('close', () => { resolve() })
  })
}

const execFileAsync = promisify(execFile)
const PROCESS_FILETIME_SCRIPT = '$id = [int][Environment]::GetEnvironmentVariable(\'DSH_DESKTOP_PROCESS_ID\', \'Process\'); [Console]::Out.Write(([Diagnostics.Process]::GetProcessById($id).StartTime.ToUniversalTime().ToFileTimeUtc()).ToString())'

/** Read a live Windows FILETIME without embedding the PID in a command string. */
async function readWindowsCreationFiletime(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(PROCESS_FILETIME_SCRIPT, 'utf16le').toString('base64'),
    ], { env: { ...process.env, DSH_DESKTOP_PROCESS_ID: String(pid) }, windowsHide: true })
    const value = result.stdout.trim()
    return /^[1-9][0-9]{16,19}$/.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Schedule a disposable identity monitor that cannot keep Electron alive by itself. */
function monitorIdentity(milliseconds: number, task: () => void): () => void {
  const timer = setInterval(task, milliseconds)
  timer.unref()
  return () => { clearInterval(timer) }
}

/** Production process and loopback operations for Electron's Windows main process. */
export function createNodeBackendAdapter(): BackendAdapter {
  return {
    fetch: async (url, init) => await fetch(url, init),
    probeLoopback: probeLoopbackTcp,
    creationFiletime: readWindowsCreationFiletime,
    spawn: createNodeChild,
    terminateTree: terminateWindowsTree,
    monitor: monitorIdentity,
    wait: async milliseconds => await new Promise((resolve) => { setTimeout(resolve, milliseconds) }),
    now: () => Date.now(),
  }
}
