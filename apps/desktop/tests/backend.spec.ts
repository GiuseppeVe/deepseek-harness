import { describe, expect, it } from 'vitest'
import type { BackendIdentity, BackendLease, LeaseStore } from '../src/lease.ts'
import { DshBackend, DESKTOP_ORIGIN, type DesktopChild, type SpawnRequest } from '../src/backend.ts'

const IDENTITY: BackendIdentity = {
  pid: 71,
  nonce: 'backend-instance-nonce-with-at-least-32-chars',
  creationFiletime: '134010000000000000',
}

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

function child(pid = IDENTITY.pid, tail = 'last backend line'): DesktopChild & { emitExit(code: number): void } {
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
  occupancy?: Array<'free' | 'occupied'>
  readiness?: Response[]
  identities?: Response[]
  creationFiletimes?: Array<string | undefined>
  status?: Response[]
  shutdown?: Response
  spawnedChild?: TestChild
  tail?: string
  prepareData?: () => Promise<void>
} = {}) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  const spawns: SpawnRequest[] = []
  const terminations: BackendIdentity[] = []
  const monitors: Array<{ milliseconds: number; task: () => void }> = []
  let clock = 0
  const store = memoryLease(input.lease)
  const liveChild = input.spawnedChild ?? child(IDENTITY.pid, input.tail)
  const occupancy = [...(input.occupancy ?? ['free'])]
  const readiness = [...(input.readiness ?? [response(503), response(204)])]
  const identities = [...(input.identities ?? [
    response(200, { pid: IDENTITY.pid, nonce: IDENTITY.nonce }),
    response(200, { pid: IDENTITY.pid, nonce: IDENTITY.nonce }),
  ])]
  const creationFiletimes = [...(input.creationFiletimes ?? [IDENTITY.creationFiletime, IDENTITY.creationFiletime])]
  const status = [...(input.status ?? [response(200, { activity: 'idle' })])]
  const backend = new DshBackend({
    paths: {
      home: 'C:/Users/A/AppData/Local/DSH Desktop',
      env: 'C:/Users/A/AppData/Local/DSH Desktop/.env',
      logs: 'C:/Users/A/AppData/Local/DSH Desktop/logs',
      lease: 'C:/Users/A/AppData/Local/DSH Desktop/backend.lease.json',
    },
    lease: store,
    prepareData: input.prepareData ?? (async () => {}),
    createToken: () => 'generated-control-token-with-at-least-32-chars',
    config: {
      cliEntry: 'C:/Program Files/DSH Desktop/resources/dsh.mjs',
      electronExecutable: 'C:/Program Files/DSH Desktop/DSH Desktop.exe',
      patchPath: 'C:/Program Files/DSH Desktop/resources/desktop.cordis.patch.yml',
      startTimeoutMs: 5,
      stopDeadlineMs: 5,
      reattachMonitorMs: 10,
    },
    adapter: {
      fetch: async (url, init) => {
        requests.push({ url, init })
        if (url.endsWith('/__dsh/ready')) return readiness.shift() ?? response(503)
        if (url.endsWith('/__dsh/desktop/identity')) return identities.shift() ?? response(503)
        if (url.endsWith('/__dsh/desktop/status')) return status.shift() ?? response(503)
        if (url.endsWith('/__dsh/desktop/shutdown')) return input.shutdown ?? response(202)
        throw new Error(`unexpected URL: ${url}`)
      },
      spawn: (request) => {
        spawns.push(request)
        return liveChild
      },
      probeLoopback: async () => occupancy.shift() ?? 'occupied',
      creationFiletime: async () => creationFiletimes.shift(),
      terminateTree: async (identity) => { terminations.push(identity) },
      monitor: (milliseconds, task) => {
        monitors.push({ milliseconds, task })
        return () => {}
      },
      wait: async () => { clock += 1 },
      now: () => clock,
    },
  })
  return { backend, liveChild, requests, spawns, terminations, monitors, store }
}

describe('DshBackend', () => {
  it('starts one Electron-as-Node CLI, proves its exact identity, and leases no credential through arguments', async () => {
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
    expect(harness.store.value).toEqual({ ...IDENTITY, token: 'generated-control-token-with-at-least-32-chars' })
  })

  it('treats every occupied loopback listener without ready, lease, and exact identity proof as a port conflict', async () => {
    const harness = backendHarness({ occupancy: ['occupied'], readiness: [response(404)] })

    await expect(harness.backend.start()).rejects.toThrow('DSH Desktop port conflict')

    expect(harness.spawns).toEqual([])
    expect(harness.terminations).toEqual([])
  })

  it('reattaches only after readiness, token, nonce, pid, and creation FILETIME validate its lease', async () => {
    const lease: BackendLease = { ...IDENTITY, token: 'retained-control-token-with-at-least-32-chars' }
    const harness = backendHarness({
      lease,
      occupancy: ['occupied'],
      readiness: [response(204)],
      identities: [response(200, { pid: IDENTITY.pid, nonce: IDENTITY.nonce })],
      creationFiletimes: [IDENTITY.creationFiletime],
    })

    await expect(harness.backend.start()).resolves.toEqual({ origin: DESKTOP_ORIGIN })

    expect(harness.spawns).toEqual([])
    expect(harness.monitors).toHaveLength(1)
    expect(harness.monitors[0]?.milliseconds).toBe(10)
  })

  it('refuses a reattach whose authenticated nonce or current FILETIME differs', async () => {
    const lease: BackendLease = { ...IDENTITY, token: 'retained-control-token-with-at-least-32-chars' }
    const harness = backendHarness({
      lease,
      occupancy: ['occupied'],
      readiness: [response(204)],
      identities: [response(200, { pid: IDENTITY.pid, nonce: 'other-instance-nonce-with-at-least-32-chars' })],
    })

    await expect(harness.backend.start()).rejects.toThrow('DSH Desktop port conflict')

    expect(harness.spawns).toEqual([])
    expect(harness.terminations).toEqual([])
  })

  it('does not force a spawned process that never authenticated an exact identity', async () => {
    const harness = backendHarness({
      readiness: [response(503), response(503), response(503), response(503), response(503), response(503)],
      tail: 'last backend line',
    })

    await expect(harness.backend.start()).rejects.toThrow('last backend line')

    expect(harness.terminations).toEqual([])
  })

  it('sends authenticated status without exposing credentials and reports active work', async () => {
    const harness = backendHarness({ status: [response(200, { activity: 'active' })] })
    await harness.backend.start()

    await expect(harness.backend.status()).resolves.toBe('active')

    const statusRequest = harness.requests.at(-1)
    expect(statusRequest?.url).toBe(`${DESKTOP_ORIGIN}/__dsh/desktop/status`)
    expect(statusRequest?.init?.headers instanceof Headers && statusRequest.init.headers.get('authorization')?.startsWith('Bearer ') === true).toBe(true)
  })

  it('forces only an identity that still authenticates with its current FILETIME', async () => {
    const harness = backendHarness()
    await harness.backend.start()

    await harness.backend.stop()

    expect(harness.terminations).toEqual([IDENTITY])
    expect(harness.requests.some(request => request.url.endsWith('/__dsh/desktop/shutdown'))).toBe(true)
  })

  it('never force-terminates when PID reuse changes the current FILETIME', async () => {
    const harness = backendHarness({ creationFiletimes: [IDENTITY.creationFiletime, '134020000000000000'] })
    await harness.backend.start()

    await expect(harness.backend.stop()).rejects.toThrow('DSH Desktop port conflict')

    expect(harness.terminations).toEqual([])
  })

  it('reports an identity-monitor failure for a reattached backend without termination', async () => {
    const lease: BackendLease = { ...IDENTITY, token: 'retained-control-token-with-at-least-32-chars' }
    const harness = backendHarness({
      lease,
      occupancy: ['occupied'],
      readiness: [response(204)],
      identities: [
        response(200, { pid: IDENTITY.pid, nonce: IDENTITY.nonce }),
        response(200, { pid: IDENTITY.pid, nonce: 'reused-instance-nonce-with-at-least-32-chars' }),
      ],
      creationFiletimes: [IDENTITY.creationFiletime],
    })
    const unavailable: Array<number | null> = []
    harness.backend.onUnexpectedExit((code) => { unavailable.push(code) })

    await harness.backend.start()
    harness.monitors[0]?.task()
    await new Promise<void>((resolve) => { setImmediate(resolve) })

    expect(unavailable).toEqual([null])
    expect(harness.terminations).toEqual([])
  })

  it('serializes concurrent start requests before spawning', async () => {
    let releasePreparation: (() => void) | undefined
    const prepared = new Promise<void>((resolve) => { releasePreparation = resolve })
    const harness = backendHarness({ prepareData: async () => await prepared })

    const first = harness.backend.start()
    const second = harness.backend.start()
    releasePreparation?.()
    await Promise.all([first, second])

    expect(harness.spawns).toHaveLength(1)
  })

  it('distinguishes unexpected direct-child exit from user-requested shutdown', async () => {
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
