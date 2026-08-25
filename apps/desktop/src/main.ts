/** Electron main-process lifecycle for one loopback DSH backend. */

import { fileURLToPath } from 'node:url'
import { DESKTOP_ORIGIN, type BackendReady, type BackendStatus, DshBackend, createControlToken, createNodeBackendAdapter } from './backend.ts'
import { registerDesktopIpc } from './ipc.ts'
import { createLeaseStore, nodeLeaseFileAdapter } from './lease.ts'
import { createNodeWindowsDesktopPathAdapter, prepareDesktopPaths, resolveDesktopPaths } from './paths.ts'

/** User decision for an active-work close confirmation. */
export type CloseDecision = 'wait' | 'close'
/** Native recovery state reported without backend diagnostic content. */
export type RecoveryKind = 'startup' | 'unavailable'
/** Native recovery decision after a backend failure. */
export type RecoveryDecision = 'retry' | 'quit'

/** BrowserWindow webContents operations DSH Desktop needs. */
export interface DesktopWebContents {
  /** Electron's sole top-level frame used to validate IPC. */
  mainFrame: unknown
  /** Deny every attempted secondary window. */
  setWindowOpenHandler(listener: (details: unknown) => { action: 'deny' }): void
  /** Observe every main or subframe navigation attempt and redirect. */
  on(event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): void
}

/** Electron BrowserWindow capabilities used by Desktop main. */
export interface DesktopWindow {
  /** Main window's renderer connection. */
  webContents: DesktopWebContents
  /** Load the fixed DSH loopback UI. */
  loadURL(url: typeof DESKTOP_ORIGIN): Promise<void>
  /** Observe close requests before Electron destroys the window. */
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void
  /** Reissue close after main-process coordination allows it. */
  close(): void
  /** Report whether the user minimized the existing window. */
  isMinimized(): boolean
  /** Restore an existing minimized window for a second launch. */
  restore(): void
  /** Focus the existing window for a second launch. */
  focus(): void
}

/** Minimal Electron app operations required before backend startup. */
export interface DesktopApp {
  /** Claim one Desktop instance for this Windows user. */
  requestSingleInstanceLock(): boolean
  /** Wait until BrowserWindow creation is available. */
  whenReady(): Promise<void>
  /** Exit the losing second process before it starts DSH. */
  quit(): void
  /** Observe second launch requests. */
  on(event: 'second-instance', listener: () => void): void
}

/** Backend operations owned by Electron main. */
export interface DesktopMainBackend {
  /** Start or attach the one authenticated loopback backend. */
  start(): Promise<BackendReady>
  /** Gracefully stop and, if needed, terminate only the owned child tree. */
  stop(): Promise<void>
  /** Restart with unchanged Desktop data paths and loopback port. */
  restart(): Promise<BackendReady>
  /** Query authenticated backend work state. */
  status(): Promise<BackendStatus>
  /** Subscribe to unexpected direct-child or reattached-identity failure. */
  onUnexpectedExit(listener: (code: number | null) => void): () => void
}

/** Dependencies for Electron's source-level main controller. */
export interface DesktopMainOptions {
  /** Electron application lifecycle operations. */
  app: DesktopApp
  /** Construct the sole hardened Electron window. */
  createWindow(options: { webPreferences: {
    contextIsolation: true
    nodeIntegration: false
    webSecurity: true
    webviewTag: false
    preload: string
  } }): DesktopWindow
  /** One backend supervisor owned by this Electron process. */
  backend: DesktopMainBackend
  /** Prompt only when status reports active work. */
  confirmClose(): Promise<CloseDecision>
  /** Show a native Retry/Quit or Restart backend/Quit decision without diagnostics. */
  showRecovery(kind: RecoveryKind): Promise<RecoveryDecision>
  /** Fixed packaged preload module path. */
  preloadPath: string
  /** Receive the sole window after hardening and before backend startup. */
  onWindowCreated?(window: DesktopWindow): void
}

/** Start controller returned for Electron bootstrap and focused tests. */
export interface DesktopMainController {
  /** Claim the instance lock, build the hardened window, then boot DSH. */
  start(): Promise<void>
  /** Coordinate a close requested through renderer IPC. */
  requestClose(): Promise<boolean>
}

/** Apply DSH status to one close request before Electron destroys its window. */
export async function requestWindowClose(
  backend: Pick<DesktopMainBackend, 'status' | 'stop'>,
  confirmClose: () => Promise<CloseDecision>,
): Promise<boolean> {
  if (await backend.status() === 'active' && await confirmClose() === 'wait') return false
  await backend.stop()
  return true
}

/** Check one navigation URL against Desktop's fixed loopback origin. */
function isDesktopOrigin(url: string): boolean {
  try {
    return new URL(url).origin === DESKTOP_ORIGIN
  } catch {
    return false
  }
}

/** Create a single-window Desktop lifecycle controller without importing Electron in tests. */
export function createDesktopMain(options: DesktopMainOptions): DesktopMainController {
  let window: DesktopWindow | undefined
  let closing = false
  let pendingFocus = false
  let startPromise: Promise<void> | undefined
  let recoveryQueued = false
  let lifecycle: Promise<void> = Promise.resolve()

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = lifecycle.then(operation, operation)
    lifecycle = run.then(() => undefined, () => undefined)
    return await run
  }

  const focusWindow = (): void => {
    const existing = window
    if (existing === undefined) {
      pendingFocus = true
      return
    }
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  }

  const closeWindow = async (): Promise<boolean> => await serialize(async () => {
    const allowed = await requestWindowClose(options.backend, options.confirmClose)
    if (allowed) {
      closing = true
      window?.close()
    }
    return allowed
  })

  const hardenWindow = (created: DesktopWindow): void => {
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const denyNonDesktopNavigation = (event: { preventDefault(): void }, url: string): void => {
      if (!isDesktopOrigin(url)) event.preventDefault()
    }
    created.webContents.on('will-navigate', denyNonDesktopNavigation)
    created.webContents.on('will-frame-navigate', denyNonDesktopNavigation)
    created.webContents.on('will-redirect', denyNonDesktopNavigation)
    created.on('close', (event) => {
      if (closing) return
      event.preventDefault()
      void closeWindow()
    })
  }

  const loadWithRecovery = async (kind: RecoveryKind, restart: boolean): Promise<void> => {
    while (true) {
      try {
        const ready = restart ? await options.backend.restart() : await options.backend.start()
        await window?.loadURL(ready.origin)
        return
      } catch {
        if (await options.showRecovery(kind) === 'quit') {
          options.app.quit()
          return
        }
      }
    }
  }

  const recoverUnexpectedBackend = (): void => {
    if (recoveryQueued || closing) return
    recoveryQueued = true
    void serialize(async () => {
      try {
        if (await options.showRecovery('unavailable') === 'quit') {
          options.app.quit()
          return
        }
        await loadWithRecovery('unavailable', true)
      } finally {
        recoveryQueued = false
      }
    })
  }

  const start = async (): Promise<void> => {
    if (startPromise !== undefined) return await startPromise
    startPromise = serialize(async () => {
      if (!options.app.requestSingleInstanceLock()) {
        options.app.quit()
        return
      }
      options.app.on('second-instance', focusWindow)
      await options.app.whenReady()
      const created = options.createWindow({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          webviewTag: false,
          preload: options.preloadPath,
        },
      })
      window = created
      hardenWindow(created)
      options.onWindowCreated?.(created)
      options.backend.onUnexpectedExit(recoverUnexpectedBackend)
      if (pendingFocus) focusWindow()
      await loadWithRecovery('startup', false)
    })
    return await startPromise
  }

  return { start, requestClose: closeWindow }
}

/** Start the Windows Electron entry using only its packaged executable and runtime files. */
export async function startElectronDesktop(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('DSH Desktop supports Windows only')
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData === undefined || localAppData.length === 0) throw new Error('DSH Desktop requires LOCALAPPDATA')
  const electron = await import('electron')
  const paths = resolveDesktopPaths(localAppData)
  const backend = new DshBackend({
    paths,
    lease: createLeaseStore(paths.lease, nodeLeaseFileAdapter),
    prepareData: async () => await prepareDesktopPaths(paths, createNodeWindowsDesktopPathAdapter()),
    createToken: createControlToken,
    config: {
      electronExecutable: process.execPath,
      cliEntry: fileURLToPath(new URL('../runtime/dsh.mjs', import.meta.url)),
      patchPath: fileURLToPath(new URL('../runtime/desktop.cordis.patch.yml', import.meta.url)),
      startTimeoutMs: 30_000,
      stopDeadlineMs: 5_000,
      reattachMonitorMs: 2_000,
    },
    adapter: createNodeBackendAdapter(),
  })
  let mainWindow: DesktopWindow | undefined
  const controller = createDesktopMain({
    app: {
      requestSingleInstanceLock: () => electron.app.requestSingleInstanceLock(),
      whenReady: async () => await electron.app.whenReady(),
      quit: () => { electron.app.quit() },
      on: (event, listener) => { electron.app.on(event, listener) },
    },
    createWindow: options => new electron.BrowserWindow(options) as unknown as DesktopWindow,
    backend,
    confirmClose: async () => (await electron.dialog.showMessageBox({
      type: 'warning',
      buttons: ['Wait', 'Close anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'DSH is processing work.',
    })).response === 0 ? 'wait' : 'close',
    showRecovery: async kind => (await electron.dialog.showMessageBox({
      type: 'error',
      buttons: kind === 'startup' ? ['Retry', 'Quit'] : ['Restart backend', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      message: kind === 'startup' ? 'DSH backend did not start.' : 'DSH backend is unavailable.',
    })).response === 0 ? 'retry' : 'quit',
    preloadPath: fileURLToPath(new URL('./preload.js', import.meta.url)),
    onWindowCreated: (window) => {
      mainWindow = window
      registerDesktopIpc({
        handle: (channel, listener) => {
          electron.ipcMain.handle(channel, async event => await listener({ sender: event.sender, senderFrame: event.senderFrame }))
        },
      }, () => mainWindow?.webContents, () => mainWindow?.webContents.mainFrame, backend, controller.requestClose)
    },
  })
  await controller.start()
}

if (process.versions.electron !== undefined && process.env.ELECTRON_RUN_AS_NODE !== '1') {
  void startElectronDesktop()
}
