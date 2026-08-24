/** Narrow authenticated Electron IPC registration for DSH Desktop. */

import type { BackendReady, BackendStatus } from './backend.ts'

/** Renderer IPC channel names owned by Desktop main. */
export const DESKTOP_IPC_CHANNELS = {
  status: 'dsh:backend-status',
  restart: 'dsh:backend-restart',
  requestClose: 'dsh:desktop-request-close',
} as const

/** Sender identity carried by Electron's main-process IPC handlers. */
export interface DesktopIpcEvent {
  /** Electron webContents that invoked the handler. */
  sender: unknown
}

/** Minimal main-process IPC registrar. */
export interface DesktopIpcMain {
  /** Register one request/response handler. */
  handle(channel: string, listener: (event: DesktopIpcEvent) => Promise<unknown>): void
}

/** Backend operations intentionally visible to the renderer. */
export interface DesktopIpcBackend {
  /** Read current authenticated backend work state. */
  status(): Promise<BackendStatus>
  /** Restart an owned backend using unchanged Desktop paths. */
  restart(): Promise<BackendReady>
}

/** Register only Desktop's three renderer requests against its one window. */
export function registerDesktopIpc(
  ipc: DesktopIpcMain,
  mainContents: () => unknown,
  backend: DesktopIpcBackend,
  requestClose: () => Promise<boolean>,
): void {
  const requireMainWindow = (event: DesktopIpcEvent): void => {
    if (event.sender !== mainContents()) throw new Error('Desktop IPC sender rejected')
  }
  ipc.handle(DESKTOP_IPC_CHANNELS.status, async (event) => {
    requireMainWindow(event)
    return await backend.status()
  })
  ipc.handle(DESKTOP_IPC_CHANNELS.restart, async (event) => {
    requireMainWindow(event)
    return await backend.restart()
  })
  ipc.handle(DESKTOP_IPC_CHANNELS.requestClose, async (event) => {
    requireMainWindow(event)
    return await requestClose()
  })
}
