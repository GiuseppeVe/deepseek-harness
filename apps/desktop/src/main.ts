/** Electron main-process lifecycle for one loopback DSH backend. */

import { fileURLToPath } from 'node:url'
import { DESKTOP_ORIGIN, type BackendReady, type BackendStatus } from './backend.ts'
import { DshBackend, createControlToken, createNodeBackendAdapter } from './backend.ts'
import { registerDesktopIpc } from './ipc.ts'
import { createLeaseStore, nodeLeaseFileAdapter } from './lease.ts'
import { createNodeWindowsDesktopPathAdapter, prepareDesktopPaths, resolveDesktopPaths } from './paths.ts'

/** User decision for an active-work close confirmation. */
export type CloseDecision = 'wait' | 'close'

/** BrowserWindow webContents operations DSH Desktop needs. */
export interface DesktopWebContents {
  /** Notify renderer about one backend lifecycle change. */
  send(channel: 'dsh:unavailable'): void
  /** Deny every attempted secondary window. */
  setWindowOpenHandler(listener: (details: unknown) => { action: 'deny' }): void
  /** Observe navigation attempts before the renderer leaves loopback. */
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): void
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
  /** Subscribe to unexpected child exit. */
  onUnexpectedExit(listener: (code: number | null) => void): () => void
}

/** Dependencies for Electron's source-level main controller. */
export interface DesktopMainOptions {
  /** Electron application lifecycle operations. */
  app: DesktopApp
  /** Construct the sole hardened Electron window. */
  createWindow(options: { webPreferences: { contextIsolation: true; nodeIntegration: false; preload: string } }): DesktopWindow
  /** One backend supervisor owned by this Electron process. */
  backend: DesktopMainBackend
  /** Prompt only when status reports active work. */
  confirmClose(): Promise<CloseDecision>
  /** Fixed packaged preload module path. */
  preloadPath: string
  /** Receive the sole window after its hardening has been installed. */
  onWindowCreated?(window: DesktopWindow): void
}

/** Start controller returned for Electron bootstrap and focused tests. */
export interface DesktopMainController {
  /** Claim the instance lock, boot DSH, and create the hardened window. */
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

/** Create a single-window Desktop lifecycle controller without importing Electron in tests. */
export function createDesktopMain(options: DesktopMainOptions): DesktopMainController {
  let window: DesktopWindow | undefined
  let closing = false

  const focusWindow = (): void => {
    const existing = window
    if (existing === undefined) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  }

  const closeWindow = async (): Promise<boolean> => {
    const allowed = await requestWindowClose(options.backend, options.confirmClose)
    if (allowed) {
      closing = true
      window?.close()
    }
    return allowed
  }

  const hardenWindow = (created: DesktopWindow): void => {
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.webContents.on('will-navigate', (event, url) => {
      try {
        if (new URL(url).origin !== DESKTOP_ORIGIN) event.preventDefault()
      } catch {
        event.preventDefault()
      }
    })
    created.on('close', (event) => {
      if (closing) return
      event.preventDefault()
      void closeWindow()
    })
  }

  return {
    async start(): Promise<void> {
      if (!options.app.requestSingleInstanceLock()) {
        options.app.quit()
        return
      }
      options.app.on('second-instance', focusWindow)
      await options.app.whenReady()
      const ready = await options.backend.start()
      const created = options.createWindow({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          preload: options.preloadPath,
        },
      })
      window = created
      hardenWindow(created)
      options.onWindowCreated?.(created)
      options.backend.onUnexpectedExit(() => { window?.webContents.send('dsh:unavailable') })
      await created.loadURL(ready.origin)
    },
    requestClose: closeWindow,
  }
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
    preloadPath: fileURLToPath(new URL('./preload.js', import.meta.url)),
    onWindowCreated: (window) => {
      mainWindow = window
      registerDesktopIpc({
        handle: (channel, listener) => {
          electron.ipcMain.handle(channel, async event => await listener({ sender: event.sender }))
        },
      }, () => mainWindow?.webContents, backend, controller.requestClose)
    },
  })
  await controller.start()
}

if (process.versions.electron !== undefined && process.env.ELECTRON_RUN_AS_NODE !== '1') {
  void startElectronDesktop()
}
