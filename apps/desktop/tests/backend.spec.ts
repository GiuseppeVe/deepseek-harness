import { describe, expect, it } from 'vitest'
import type { BackendLease, LeaseStore } from '../src/lease.ts'
import { DshBackend, DESKTOP_ORIGIN, type DesktopChild, type SpawnRequest } from '../src/backend.ts'

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status })
}

function memoryLease(initial?: BackendLease): LeaseStore & { value: BackendLease | undefined } {
  const store: LeaseStore & { value: BackendLease | undefined } = {
    value: initial,
    read: async () => store.value,
    write: async (lease) => { store.value = lease },
    remove: async () => { store.value = undefined },
  }
  return store
}

function child(pid = 71, tail = 'last backend line'): DesktopChild & { emitExit(code: number): void } {
  const listeners: Array<(code: number | null) => void> = []
  return {
    pid,
    logTail: () => tail,
    onExit(listener) {
      listeners.push(listener)
      return () => { listeners.splice(listeners.indexOf(listener), 1) }
    },
    emitExit(code) {
      for (const listener of listeners) listener(code)
    },
  }
}

type TestChild = ReturnType<typeof child>

function backendHarness(input: {
  lease?: BackendLease
  readiness?: Response[]
  status?: Response[]
  shutdown?: Response
  spawnedChild?: TestChild
  tail?: string
} = {}) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  const spawns: SpawnRequest[] = []
  const terminations: number[] = []
  let clock = 0
  const store = memoryLease(input.lease)
  const liveChild = input.spawnedChild ?? child(71, input.tail)
  const readiness = [...(input.readiness ?? [response(503), response(204)])]
  const status = [...(input.status ?? [response(200, { activity: 'idle' })])]
  const backend = new DshBackend({
    paths: {
      home: 'C:/Users/A/AppData/Local/DSH Desktop',
      env: 'C:/Users/A/AppData/Local/DSH Desktop/.env',
      logs: 'C:/Users/A/AppData/Local/DSH Desktop/logs',
      lease: 'C:/Users/A/AppData/Local/DSH Desktop/backend.lease.json',
    },
    lease: store,
    prepareData: async () => {},
    createToken: () => 'generated-control-token-with-at-least-32-chars',
    config: {
      cliEntry: 'C:/Program Files/DSH Desktop/resources/dsh.mjs',
      electronExecutable: 'C:/Program Files/DSH Desktop/DSH Desktop.exe',
      patchPath: 'C:/Program Files/DSH Desktop/resources/desktop.cordis.patch.yml',
      startTimeoutMs: 5,
      stopDeadlineMs: 5,
    },
    adapter: {
      fetch: async (url, init) => {
        requests.push({ url, init })
        if (url.endsWith('/__dsh/ready')) return readiness.shift() ?? response(503)
        if (url.endsWith('/__dsh/desktop/status')) return status.shift() ?? response(503)
        if (url.endsWith('/__dsh/desktop/shutdown')) return input.shutdown ?? response(202)
        throw new Error(`unexpected URL: ${url}`)
      },
      spawn: (request) => {
        spawns.push(request)
        return liveChild
      },
      terminateTree: async (pid) => { terminations.push(pid) },
      wait: async () => { clock += 1 },
      now: () => clock,
    },
  })
  return { backend, liveChild, requests, spawns, terminations, store }
}

describe('DshBackend', () => {
  it('starts one Electron-as-Node CLI with the final Desktop patch and private token environment', async () => {
    const harness = backendHarness()

    await expect(harness.backend.start()).resolves.toEqual({ origin: DESKTOP_ORIGIN })

    expect(harness.spawns).toEqual([{
      executable: 'C:/Program Files/DSH Desktop/DSH Desktop.exe',
      args: [
        'C:/Program Files/DSH Desktop/resources/dsh.mjs',
        'web',
        '--no-open',
        '--host',
        '127.0.0.1',
        '--port',
        '3080',
        '--patch',
        'C:/Program Files/DSH Desktop/resources/desktop.cordis.patch.yml',
      ],
      env: expect.objectContaining({
        DSH_HOME: 'C:/Users/A/AppData/Local/DSH Desktop',
        ELECTRON_RUN_AS_NODE: '1',
      }),
    }])
    expect(harness.spawns[0]?.args.join(' ')).not.toContain('generated-control-token')
    expect(harness.store.value?.pid).toBe(71)
  })

  it('refuses a ready listener without a token-validated lease instead of replacing it', async () => {
    const harness = backendHarness({ readiness: [response(204)] })

    await expect(harness.backend.start()).rejects.toThrow('DSH Desktop port conflict')

    expect(harness.spawns).toEqual([])
    expect(harness.terminations).toEqual([])
  })

  it('reattaches only after readiness and authenticated status validate its lease', async () => {
    const harness = backendHarness({
      lease: { pid: 91, token: 'retained-control-token-with-at-least-32-chars' },
      readiness: [response(204)],
      status: [response(200, { activity: 'idle' })],
    })

    await expect(harness.backend.start()).resolves.toEqual({ origin: DESKTOP_ORIGIN })

    expect(harness.spawns).toEqual([])
    const statusRequest = harness.requests.find(request => request.url.endsWith('/__dsh/desktop/status'))
    expect(statusRequest?.init?.headers instanceof Headers && statusRequest.init.headers.get('authorization')?.startsWith('Bearer ') === true).toBe(true)
  })

  it('rejects bounded startup timeout with backend log tail but no control token', async () => {
    const harness = backendHarness({
      readiness: [response(503), response(503), response(503), response(503), response(503), response(503)],
      tail: 'last backend line',
    })

    await expect(harness.backend.start()).rejects.toThrow('last backend line')

    expect(harness.terminations).toEqual([71])
  })

  it('refuses a child without a positive PID before any process-tree action', async () => {
    const harness = backendHarness({ spawnedChild: child(-1), readiness: [response(503)] })

    await expect(harness.backend.start()).rejects.toThrow('positive PID')

    expect(harness.terminations).toEqual([])
  })

  it('sends authenticated status without exposing credentials and reports active work', async () => {
    const harness = backendHarness({ status: [response(200, { activity: 'idle' }), response(200, { activity: 'active' })] })
    await harness.backend.start()

    await expect(harness.backend.status()).resolves.toBe('active')

    const statusRequest = harness.requests.at(-1)
    expect(statusRequest?.url).toBe(`${DESKTOP_ORIGIN}/__dsh/desktop/status`)
    expect(statusRequest?.init?.headers instanceof Headers && statusRequest.init.headers.get('authorization')?.startsWith('Bearer ') === true).toBe(true)
  })

  it('forces only its authenticated child tree after bounded graceful shutdown', async () => {
    const harness = backendHarness()
    await harness.backend.start()

    await harness.backend.stop()

    expect(harness.terminations).toEqual([71])
    expect(harness.requests.at(-1)?.url).toBe(`${DESKTOP_ORIGIN}/__dsh/desktop/shutdown`)
  })

  it('distinguishes unexpected child exit from user-requested shutdown', async () => {
    const harness = backendHarness()
    const unavailable: number[] = []
    harness.backend.onUnexpectedExit((code) => { unavailable.push(code ?? -1) })
    await harness.backend.start()

    harness.liveChild.emitExit(1)
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    expect(unavailable).toEqual([1])
    await expect(harness.backend.status()).resolves.toBe('unavailable')
  })
})
