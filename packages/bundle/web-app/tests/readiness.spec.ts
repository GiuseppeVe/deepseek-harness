import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, internals } from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
const originalResolve = internals.resolveDistIndex

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  internals.resolveDistIndex = originalResolve
})

async function mount(settlement: Promise<void>): Promise<{ context: Context; runtime: ReturnType<Context['plugin']> }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-readiness-'))
  roots.push(root)
  const dist = join(root, 'dist')
  mkdirSync(dist)
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>ready</title>')
  internals.resolveDistIndex = () => join(dist, 'index.html')

  const context = new Context()
  contexts.push(context)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  context.provide('loader', { await: () => settlement } as never)
  const runtime = context.plugin({
    inject: ['webServer'],
    apply: (runtimeContext: Context) => {
      apply(runtimeContext, new Config({ openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] }))
    },
  })
  await runtime
  await new Promise<void>(resolve => setImmediate(resolve))
  return { context, runtime }
}

describe('web readiness route', () => {
  it('waits for Loader settlement before returning 204', async () => {
    let release!: () => void
    const settlement = new Promise<void>((resolve) => { release = resolve })
    const { context } = await mount(settlement)
    const url = `http://127.0.0.1:${String(context.webServer.port)}/__dsh/ready`
    const request = fetch(url)
    const beforeSettlement = await Promise.race([
      request.then(() => 'settled'),
      new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 50)),
    ])
    expect(beforeSettlement).toBe('pending')
    release()
    await expect(request).resolves.toMatchObject({ status: 204 })
  })

  it('returns 405 for non-GET before Loader settlement', async () => {
    const { context } = await mount(new Promise<void>(() => {}))
    const url = `http://127.0.0.1:${String(context.webServer.port)}/__dsh/ready`
    await expect(fetch(url, { method: 'POST' })).resolves.toMatchObject({ status: 405 })
  })

  it('does not return ready when Loader settlement fails', async () => {
    let fail!: (error: Error) => void
    const settlement = new Promise<void>((_resolve, reject) => { fail = reject })
    const { context } = await mount(settlement)
    const url = `http://127.0.0.1:${String(context.webServer.port)}/__dsh/ready`
    const request = fetch(url)
    fail(new Error('boot failed'))
    await expect(request).resolves.toMatchObject({ status: 400 })
  })

  it('removes readiness route when runtime is disposed', async () => {
    const { context, runtime } = await mount(Promise.resolve())
    const url = `http://127.0.0.1:${String(context.webServer.port)}/__dsh/ready`
    await expect(fetch(url)).resolves.toMatchObject({ status: 204 })
    await runtime.dispose()
    await expect(fetch(url)).resolves.toMatchObject({ status: 404 })
  })
})
