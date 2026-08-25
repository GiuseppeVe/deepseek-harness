import { describe, expect, it, vi } from 'vitest'
import { createDesktopMain, requestWindowClose, type DesktopWindow } from '../src/main.ts'

function fakeWindow(): DesktopWindow & {
  options: unknown
  loaded: string[]
  closeListeners: Array<(event: { preventDefault(): void }) => void>
  navigateListeners: Array<(event: { preventDefault(): void }, url: string) => void>
  frameNavigateListeners: Array<(event: { preventDefault(): void }, url: string) => void>
  redirectListeners: Array<(event: { preventDefault(): void }, url: string) => void>
  focusCount: number
  restoreCount: number
} {
  const closeListeners: Array<(event: { preventDefault(): void }) => void> = []
  const navigateListeners: Array<(event: { preventDefault(): void }, url: string) => void> = []
  const frameNavigateListeners: Array<(event: { preventDefault(): void }, url: string) => void> = []
  const redirectListeners: Array<(event: { preventDefault(): void }, url: string) => void> = []
  const mainFrame = { url: 'http://127.0.0.1:3080/' }
  const window: DesktopWindow & {
    options: unknown
    loaded: string[]
    closeListeners: Array<(event: { preventDefault(): void }) => void>
    navigateListeners: Array<(event: { preventDefault(): void }, url: string) => void>
    frameNavigateListeners: Array<(event: { preventDefault(): void }, url: string) => void>
    redirectListeners: Array<(event: { preventDefault(): void }, url: string) => void>
    focusCount: number
    restoreCount: number
  } = {
    options: undefined,
    loaded: [],
    closeListeners,
    navigateListeners,
    frameNavigateListeners,
    redirectListeners,
    focusCount: 0,
    restoreCount: 0,
    webContents: {
      mainFrame,
      setWindowOpenHandler: () => ({ action: 'deny' }),
      on: (event, listener) => {
        if (event === 'will-navigate') navigateListeners.push(listener as (event: { preventDefault(): void }, url: string) => void)
        if (event === 'will-frame-navigate') frameNavigateListeners.push(listener as (event: { preventDefault(): void }, url: string) => void)
        if (event === 'will-redirect') redirectListeners.push(listener as (event: { preventDefault(): void }, url: string) => void)
      },
    },
    loadURL: async (url) => { window.loaded.push(url) },
    on: (event, listener) => {
      if (event === 'close') closeListeners.push(listener as (event: { preventDefault(): void }) => void)
    },
    close: () => {},
    isMinimized: () => true,
    restore: () => { window.restoreCount += 1 },
    focus: () => { window.focusCount += 1 },
  }
  return window
}

function fakeBackend(status: 'idle' | 'active' | 'unavailable' = 'idle') {
  const exits: Array<(code: number | null) => void> = []
  return {
    starts: 0,
    restarts: 0,
    stops: 0,
    startFailures: [] as Error[],
    restartFailures: [] as Error[],
    async start() {
      this.starts += 1
      const failure = this.startFailures.shift()
      if (failure !== undefined) throw failure
      return { origin: 'http://127.0.0.1:3080' as const }
    },
    async restart() {
      this.restarts += 1
      const failure = this.restartFailures.shift()
      if (failure !== undefined) throw failure
      return { origin: 'http://127.0.0.1:3080' as const }
    },
    async stop() { this.stops += 1 },
    async status() { return status },
    onUnexpectedExit(listener: (code: number | null) => void) {
      exits.push(listener)
      return () => { exits.splice(exits.indexOf(listener), 1) }
    },
    emitExit(code: number | null) { for (const listener of exits) listener(code) },
  }
}

function appHarness(lock = true) {
  const listeners = new Map<string, () => void>()
  let quit = 0
  return {
    app: {
      requestSingleInstanceLock: () => lock,
      whenReady: async () => {},
      quit: () => { quit += 1 },
      on: (event: 'second-instance', listener: () => void) => { listeners.set(event, listener) },
    },
    listeners,
    get quit() { return quit },
  }
}

describe('Desktop main process', () => {
  it('cancels close when active work selects Wait', async () => {
    const backend = fakeBackend('active')

    await expect(requestWindowClose(backend, async () => 'wait')).resolves.toBe(false)

    expect(backend.stops).toBe(0)
  })

  it('stops active work when Close anyway is selected', async () => {
    const backend = fakeBackend('active')

    await expect(requestWindowClose(backend, async () => 'close')).resolves.toBe(true)

    expect(backend.stops).toBe(1)
  })

  it('stops an idle backend without confirmation', async () => {
    const backend = fakeBackend('idle')

    await expect(requestWindowClose(backend, async () => 'wait')).resolves.toBe(true)

    expect(backend.stops).toBe(1)
  })

  it('creates and hardens one window before startup, queues early focus, and blocks non-loopback navigation', async () => {
    const window = fakeWindow()
    const backend = fakeBackend()
    const host = appHarness()
    host.app.whenReady = async () => { host.listeners.get('second-instance')?.() }
    let created = 0
    const main = createDesktopMain({
      app: host.app,
      createWindow: (options) => { created += 1; window.options = options; return window },
      backend,
      confirmClose: async () => 'close',
      showRecovery: async () => 'quit',
      preloadPath: 'C:/Program Files/DSH Desktop/resources/preload.mjs',
    })

    await main.start()
    host.listeners.get('second-instance')?.()
    const externalMain = { prevented: false, preventDefault() { this.prevented = true } }
    const externalFrame = { prevented: false, preventDefault() { this.prevented = true } }
    const localFrame = { prevented: false, preventDefault() { this.prevented = true } }
    const externalMainRedirect = { prevented: false, preventDefault() { this.prevented = true } }
    const externalFrameRedirect = { prevented: false, preventDefault() { this.prevented = true } }
    window.navigateListeners[0]?.(externalMain, 'https://example.com')
    window.frameNavigateListeners[0]?.(externalFrame, 'https://example.com/frame')
    window.frameNavigateListeners[0]?.(localFrame, 'http://127.0.0.1:3080/frame')
    window.redirectListeners[0]?.(externalMainRedirect, 'https://example.com/main-redirect')
    window.redirectListeners[0]?.(externalFrameRedirect, 'https://example.com/frame-redirect')

    expect(created).toBe(1)
    expect(window.loaded).toEqual(['http://127.0.0.1:3080'])
    expect(window.options).toMatchObject({ webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      preload: 'C:/Program Files/DSH Desktop/resources/preload.mjs',
    } })
    expect(window.restoreCount).toBe(2)
    expect(window.focusCount).toBe(2)
    expect(externalMain.prevented).toBe(true)
    expect(externalFrame.prevented).toBe(true)
    expect(localFrame.prevented).toBe(false)
    expect(externalMainRedirect.prevented).toBe(true)
    expect(externalFrameRedirect.prevented).toBe(true)
  })

  it('uses native retry recovery for a redacted startup failure and loads only after success', async () => {
    const window = fakeWindow()
    const backend = fakeBackend()
    backend.startFailures.push(new Error('secret token should not reach dialog'))
    const failures: string[] = []
    const main = createDesktopMain({
      app: appHarness().app,
      createWindow: () => window,
      backend,
      confirmClose: async () => 'close',
      showRecovery: async (kind) => { failures.push(kind); return 'retry' },
      preloadPath: 'preload.mjs',
    })

    await main.start()

    expect(failures).toEqual(['startup'])
    expect(backend.starts).toBe(2)
    expect(window.loaded).toEqual(['http://127.0.0.1:3080'])
  })

  it('uses native restart recovery after an unexpected backend failure without renderer event bridging', async () => {
    const window = fakeWindow()
    const backend = fakeBackend()
    const failures: string[] = []
    const main = createDesktopMain({
      app: appHarness().app,
      createWindow: () => window,
      backend,
      confirmClose: async () => 'close',
      showRecovery: async (kind) => { failures.push(kind); return 'retry' },
      preloadPath: 'preload.mjs',
    })
    await main.start()

    backend.emitExit(1)
    await vi.waitFor(() => { expect(failures).toEqual(['unavailable']) })
    expect(backend.restarts).toBe(1)
    expect(window.loaded).toEqual(['http://127.0.0.1:3080', 'http://127.0.0.1:3080'])
  })

  it('quits on a startup recovery decision without loading a loopback renderer', async () => {
    const window = fakeWindow()
    const backend = fakeBackend()
    backend.startFailures.push(new Error('backend failed'))
    const host = appHarness()
    const main = createDesktopMain({
      app: host.app,
      createWindow: () => window,
      backend,
      confirmClose: async () => 'close',
      showRecovery: async () => 'quit',
      preloadPath: 'preload.mjs',
    })

    await main.start()

    expect(host.quit).toBe(1)
    expect(window.loaded).toEqual([])
  })

  it('quits the losing instance before readiness or backend data writes', async () => {
    const backend = fakeBackend()
    let ready = 0
    const main = createDesktopMain({
      app: {
        requestSingleInstanceLock: () => false,
        whenReady: async () => { ready += 1 },
        quit: () => {},
        on: () => {},
      },
      createWindow: () => fakeWindow(),
      backend,
      confirmClose: async () => 'close',
      showRecovery: async () => 'quit',
      preloadPath: 'preload.mjs',
    })

    await main.start()

    expect(ready).toBe(0)
    expect(backend.starts).toBe(0)
  })
})
