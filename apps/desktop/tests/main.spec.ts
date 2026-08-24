import { describe, expect, it } from 'vitest'
import { createDesktopMain, requestWindowClose, type DesktopWindow } from '../src/main.ts'

function fakeWindow(): DesktopWindow & {
  options: unknown
  loaded: string[]
  sent: unknown[][]
  closeListeners: Array<(event: { preventDefault(): void }) => void>
  navigateListeners: Array<(event: { preventDefault(): void }, url: string) => void>
  focusCount: number
  restoreCount: number
} {
  const closeListeners: Array<(event: { preventDefault(): void }) => void> = []
  const navigateListeners: Array<(event: { preventDefault(): void }, url: string) => void> = []
  const window: DesktopWindow & {
    options: unknown
    loaded: string[]
    sent: unknown[][]
    closeListeners: Array<(event: { preventDefault(): void }) => void>
    navigateListeners: Array<(event: { preventDefault(): void }, url: string) => void>
    focusCount: number
    restoreCount: number
  } = {
    options: undefined,
    loaded: [],
    sent: [],
    closeListeners,
    navigateListeners,
    focusCount: 0,
    restoreCount: 0,
    webContents: {
      send: (...args) => { window.sent.push(args) },
      setWindowOpenHandler: () => ({ action: 'deny' }),
      on: (event, listener) => {
        if (event === 'will-navigate') navigateListeners.push(listener as (event: { preventDefault(): void }, url: string) => void)
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
    stops: 0,
    async start() { this.starts += 1; return { origin: 'http://127.0.0.1:3080' as const } },
    async restart() { return { origin: 'http://127.0.0.1:3080' as const } },
    async stop() { this.stops += 1 },
    async status() { return status },
    onUnexpectedExit(listener: (code: number | null) => void) {
      exits.push(listener)
      return () => { exits.splice(exits.indexOf(listener), 1) }
    },
    emitExit(code: number) { for (const listener of exits) listener(code) },
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

  it('uses one hardened window, focuses it on second launch, and blocks external navigation', async () => {
    const window = fakeWindow()
    const backend = fakeBackend()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    let created = 0
    const main = createDesktopMain({
      app: {
        requestSingleInstanceLock: () => true,
        whenReady: async () => {},
        quit: () => {},
        on: (event, listener) => { listeners.set(event, listener) },
      },
      createWindow: (options) => { created += 1; window.options = options; return window },
      backend,
      confirmClose: async () => 'close',
      preloadPath: 'C:/Program Files/DSH Desktop/resources/preload.mjs',
    })

    await main.start()
    listeners.get('second-instance')?.()
    const navigation = { prevented: false, preventDefault() { this.prevented = true } }
    window.navigateListeners[0]?.(navigation, 'https://example.com')

    expect(created).toBe(1)
    expect(window.loaded).toEqual(['http://127.0.0.1:3080'])
    expect(window.options).toMatchObject({ webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: 'C:/Program Files/DSH Desktop/resources/preload.mjs',
    } })
    expect(window.restoreCount).toBe(1)
    expect(window.focusCount).toBe(1)
    expect(navigation.prevented).toBe(true)
  })

  it('keeps the window open and exposes unavailable state after backend exit', async () => {
    const window = fakeWindow()
    const backend = fakeBackend()
    const main = createDesktopMain({
      app: {
        requestSingleInstanceLock: () => true,
        whenReady: async () => {},
        quit: () => {},
        on: () => {},
      },
      createWindow: (options) => { window.options = options; return window },
      backend,
      confirmClose: async () => 'close',
      preloadPath: 'preload.mjs',
    })
    await main.start()

    backend.emitExit(1)

    expect(window.sent).toContainEqual(['dsh:unavailable'])
  })

  it('does not start a backend when another Desktop instance owns the lock', async () => {
    const backend = fakeBackend()
    let quit = 0
    const main = createDesktopMain({
      app: {
        requestSingleInstanceLock: () => false,
        whenReady: async () => {},
        quit: () => { quit += 1 },
        on: () => {},
      },
      createWindow: () => fakeWindow(),
      backend,
      confirmClose: async () => 'close',
      preloadPath: 'preload.mjs',
    })

    await main.start()

    expect(quit).toBe(1)
    expect(backend.starts).toBe(0)
  })
})
