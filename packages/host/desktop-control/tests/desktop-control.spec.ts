/**
 * Real Loader coverage for Desktop's loopback-only control authority.
 * Requests reach the actual node:http server so authentication and effect
 * disposal are observed at the network boundary.
 */

import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as DesktopControl from '../src/index.ts'

const CONTROL_TOKEN = 'dsh-desktop-control-test-token-9b7cc4e18f4a'

let root: string | undefined
let context: Context | undefined
let agents: readonly { status: string }[] = []
let exitCodes: number[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  agents = []
  exitCodes = []
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot webserver plus control routes through the real Loader. */
async function loadComposition(withExit = true, token: string | null = CONTROL_TOKEN): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-desktop-control-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: desktop-control',
    "  name: '@deepseek-ai/dsh-host-desktop-control'",
    ...(token === null ? [] : [
      '  config:',
      `    token: '${token}'`,
    ]),
    '',
  ].join('\n'))

  context = new Context()
  context.provide('agents', { list: () => agents } as unknown as AgentRegistry)
  if (withExit) context.provide('appExit', (code) => { exitCodes.push(code) })
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-desktop-control', DesktopControl],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** Send one route request without retaining credential-bearing response diagnostics. */
async function request(port: number, path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
}

/** Return one Loader rejection message without serializing its configuration. */
async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected Loader rejection')
}

describe('Desktop control routes', () => {
  it('keeps observation and shutdown behind authenticated method-specific routes', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port

    const missingStatus = await request(port, '/__dsh/desktop/status')
    expect(missingStatus.status).toBe(401)
    expect(await missingStatus.text()).toBe('')
    const missingShutdown = await request(port, '/__dsh/desktop/shutdown', { method: 'POST' })
    expect(missingShutdown.status).toBe(401)
    expect(exitCodes).toEqual([])

    const unauthenticatedStatusMethod = await request(port, '/__dsh/desktop/status', { method: 'POST' })
    expect(unauthenticatedStatusMethod.status).toBe(401)
    const unauthenticatedShutdownMethod = await request(port, '/__dsh/desktop/shutdown')
    expect(unauthenticatedShutdownMethod.status).toBe(401)

    const wrongLength = await request(port, '/__dsh/desktop/status', {
      headers: { authorization: 'Bearer wrong' },
    })
    expect(wrongLength.status).toBe(401)
    const sameLengthWrong = await request(port, '/__dsh/desktop/status', {
      headers: { authorization: `Bearer ${'x'.repeat(CONTROL_TOKEN.length)}` },
    })
    expect(sameLengthWrong.status).toBe(401)

    const statusMethod = await request(port, '/__dsh/desktop/status', {
      method: 'POST',
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    })
    expect(statusMethod.status).toBe(405)
    const shutdownMethod = await request(port, '/__dsh/desktop/shutdown', {
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    })
    expect(shutdownMethod.status).toBe(405)

    const idle = await request(port, '/__dsh/desktop/status', {
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    })
    expect(idle.status).toBe(200)
    expect(idle.headers.get('access-control-allow-origin')).toBeNull()
    expect(await idle.json()).toEqual({ activity: 'idle' })

    agents = [{ status: 'running' }]
    const active = await request(port, '/__dsh/desktop/status', {
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    })
    expect(await active.json()).toEqual({ activity: 'active' })

    const shutdown = await request(port, '/__dsh/desktop/shutdown', {
      method: 'POST',
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    })
    expect(shutdown.status).toBe(202)
    expect(exitCodes).toEqual([0])
  })

  it('fails activation without the launcher exit hook', { timeout: 60_000 }, async () => {
    await expect(loadComposition(false)).rejects.toThrow('ctx.appExit')
  })

  it('rejects missing control-token configuration without echoing credentials', { timeout: 60_000 }, async () => {
    await expect(rejectionMessage(loadComposition(true, null))).resolves.toContain('token')
  })

  it('rejects a short control token without echoing credentials', { timeout: 60_000 }, async () => {
    const token = 'x'.repeat(31)
    const message = await rejectionMessage(loadComposition(true, token))
    expect(message.includes(token)).toBe(false)
  })

  it('requests launcher exit after the shutdown response finishes', async () => {
    const local = new Context()
    const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }> = []
    let exited = false
    local.provide('agents', { list: () => [] } as unknown as AgentRegistry)
    local.provide('appExit', () => { exited = true })
    local.provide('webServer', {
      register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) {
        routes.push(route)
        return () => {}
      },
    } as unknown as HttpServer)
    DesktopControl.apply(local, { token: CONTROL_TOKEN })

    const shutdown = routes.find(route => route.path === DesktopControl.SHUTDOWN_PATH)
    if (shutdown === undefined) throw new Error('shutdown route did not register')
    const response = new EventEmitter() as unknown as ServerResponse
    response.writeHead = () => response
    response.end = () => response
    shutdown.handler({
      method: 'POST',
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    } as IncomingMessage, response)

    expect(exited).toBe(false)
    response.emit('finish')
    expect(exited).toBe(true)
    await local.fiber.dispose()
  })

  it('contains launcher callback errors after shutdown acknowledgement', async () => {
    const local = new Context()
    const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }> = []
    local.provide('agents', { list: () => [] } as unknown as AgentRegistry)
    local.provide('appExit', () => { throw new Error('launcher callback failed') })
    local.provide('webServer', {
      register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) {
        routes.push(route)
        return () => {}
      },
    } as unknown as HttpServer)
    DesktopControl.apply(local, { token: CONTROL_TOKEN })

    const shutdown = routes.find(route => route.path === DesktopControl.SHUTDOWN_PATH)
    if (shutdown === undefined) throw new Error('shutdown route did not register')
    const response = new EventEmitter() as unknown as ServerResponse
    response.writeHead = () => response
    response.end = () => response
    shutdown.handler({
      method: 'POST',
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    } as IncomingMessage, response)

    expect(() => { response.emit('finish') }).not.toThrow()
    await local.fiber.dispose()
  })

  it('removes control routes when its owning fiber disposes', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    const control = [...loaded.loader.entries()].find(entry => entry.options.id === 'desktop-control')
    if (control === undefined) throw new Error('desktop-control entry did not mount')
    await control.fiber!.dispose()
    expect((await request(port, '/__dsh/desktop/status')).status).toBe(404)
    expect((await request(port, '/__dsh/desktop/shutdown', {
      method: 'POST',
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
    })).status).toBe(404)
    expect(exitCodes).toEqual([])
  })
})
