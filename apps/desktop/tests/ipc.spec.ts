import { describe, expect, it } from 'vitest'
import { registerDesktopIpc } from '../src/ipc.ts'
import { createPreloadApi } from '../src/preload.ts'

describe('Desktop IPC', () => {
  it('exposes only frozen backend status, restart, and close requests', async () => {
    const channels: string[] = []
    const api = createPreloadApi({
      invoke: async (channel) => {
        channels.push(channel)
        return channel === 'dsh:backend-status' ? 'idle' : undefined
      },
    })

    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.isFrozen(api.backend)).toBe(true)
    expect(Object.keys(api)).toEqual(['backend', 'desktop'])
    expect(Object.keys(api.backend)).toEqual(['status', 'restart'])
    expect(Object.keys(api.desktop)).toEqual(['requestClose'])
    await expect(api.backend.status()).resolves.toBe('idle')
    await api.backend.restart()
    await api.desktop.requestClose()
    expect(channels).toEqual(['dsh:backend-status', 'dsh:backend-restart', 'dsh:desktop-request-close'])
  })

  it('accepts handlers only from the sole main-window webContents', async () => {
    const handlers = new Map<string, (event: { sender: unknown }) => Promise<unknown>>()
    const mainContents = {}
    const backend = {
      status: async () => 'active' as const,
      restart: async () => ({ origin: 'http://127.0.0.1:3080' as const }),
    }
    let closeRequests = 0

    registerDesktopIpc({
      handle: (channel, listener) => { handlers.set(channel, listener) },
    }, () => mainContents, backend, async () => { closeRequests += 1; return false })

    await expect(handlers.get('dsh:backend-status')?.({ sender: {} })).rejects.toThrow('Desktop IPC sender rejected')
    await expect(handlers.get('dsh:backend-status')?.({ sender: mainContents })).resolves.toBe('active')
    await expect(handlers.get('dsh:backend-restart')?.({ sender: mainContents })).resolves.toEqual({ origin: 'http://127.0.0.1:3080' })
    await expect(handlers.get('dsh:desktop-request-close')?.({ sender: mainContents })).resolves.toBe(false)
    expect(closeRequests).toBe(1)
  })
})
