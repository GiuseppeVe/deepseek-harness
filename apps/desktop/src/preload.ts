/** Frozen renderer API for DSH Desktop's Electron preload. */

import type { BackendReady, BackendStatus } from './backend.ts'
import { DESKTOP_IPC_CHANNELS } from './ipc.ts'

/** Renderer-side invocation primitive supplied by Electron's ipcRenderer. */
export interface DesktopIpcInvoker {
  /** Invoke one main-process handler. */
  invoke(channel: string): Promise<unknown>
}

/** Only renderer capabilities supported by DSH Desktop. */
export interface DesktopPreloadApi {
  /** Authenticated backend lifecycle controls. */
  backend: Readonly<{
    /** Read current backend activity. */
    status(): Promise<BackendStatus>
    /** Restart an unavailable backend. */
    restart(): Promise<BackendReady>
  }>
  /** Window-close coordination. */
  desktop: Readonly<{
    /** Ask main process to apply close confirmation. */
    requestClose(): Promise<boolean>
  }>
}

/** Create the immutable API exposed through contextBridge. */
export function createPreloadApi(invoker: DesktopIpcInvoker): Readonly<DesktopPreloadApi> {
  return Object.freeze({
    backend: Object.freeze({
      status: async () => await invoker.invoke(DESKTOP_IPC_CHANNELS.status) as BackendStatus,
      restart: async () => await invoker.invoke(DESKTOP_IPC_CHANNELS.restart) as BackendReady,
    }),
    desktop: Object.freeze({
      requestClose: async () => await invoker.invoke(DESKTOP_IPC_CHANNELS.requestClose) as boolean,
    }),
  })
}

/** Inject the frozen API through an Electron-like context bridge. */
export function exposePreloadApi(
  bridge: { exposeInMainWorld(name: string, value: Readonly<DesktopPreloadApi>): void },
  invoker: DesktopIpcInvoker,
): void {
  bridge.exposeInMainWorld('dshDesktop', createPreloadApi(invoker))
}

if (process.versions.electron !== undefined) {
  const electron = await import('electron')
  exposePreloadApi(electron.contextBridge, electron.ipcRenderer)
}
