/**
 * Desktop-only control routes for observing live agent work and requesting the
 * launcher's bounded shutdown. The token stays process-local: this plugin has
 * no renderer, IPC, command-line, or persistence surface.
 * @module @deepseek-ai/dsh-host-desktop-control
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'desktop-control'
/** Services required before control routes can observe active agents. */
export const inject = ['webServer', 'agents']

/** Exact loopback route exposing aggregate agent activity. */
export const STATUS_PATH = '/__dsh/desktop/status'
/** Exact loopback route requesting launcher-owned shutdown. */
export const SHUTDOWN_PATH = '/__dsh/desktop/shutdown'

/** Plugin config for the process-local control authority. */
export interface Config {
  /** Unpredictable bearer credential inherited from the Desktop launcher. */
  token: string
}

/** Validate the bearer credential's minimum generated-token length. */
export const Config: z<Config> = z.object({
  token: z.string().min(32).required(),
})

/** Send one method or credential rejection without exposing control details. */
function reject(res: ServerResponse, status: 401 | 405): void {
  res.writeHead(status)
  res.end()
}

/** Compare one bearer credential without applying timingSafeEqual to unequal buffers. */
function authorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization
  if (header === undefined || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice('Bearer '.length))
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

/** Report only whether any live agent is currently running. */
function statusHandler(ctx: Context, expected: Buffer, req: IncomingMessage, res: ServerResponse): void {
  if (!authorized(req, expected)) {
    reject(res, 401)
    return
  }
  if (req.method !== 'GET') {
    reject(res, 405)
    return
  }
  const activity = ctx.agents.list().some(agent => agent.status === 'running') ? 'active' : 'idle'
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ activity }))
}

/** Acknowledge a valid shutdown request before handing control to the launcher. */
function shutdownHandler(
  exit: (code: number) => void,
  expected: Buffer,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  if (!authorized(req, expected)) {
    reject(res, 401)
    return
  }
  if (req.method !== 'POST') {
    reject(res, 405)
    return
  }
  res.writeHead(202)
  res.end()
  exit(0)
}

/**
 * Register authenticated loopback controls with the shared HTTP carrier.
 * @param ctx - plugin context carrying webServer, agents, and launcher appExit.
 * @param config - validated control credential.
 * @throws when the launcher did not provide its bounded exit callback.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('desktop-control: launcher must provide ctx.appExit before control routes mount')
  }
  const expected = Buffer.from(config.token)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (req, res) => { statusHandler(ctx, expected, req, res) },
  }), 'desktop-control: status route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SHUTDOWN_PATH,
    handler: (req, res) => { shutdownHandler(exit, expected, req, res) },
  }), 'desktop-control: shutdown route')
}
