import { describe, expect, it } from 'vitest'
import { registerDesktopIpc } from '../src/ipc.ts'
import { canExposePreloadApi, createPreloadApi } from '../src/preload.ts'

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

  it('allows IPC only from the sole top-level Desktop-origin frame', async () => {
    const handlers = new Map<string, (event: { sender: unknown; senderFrame: unknown }) => Promise<unknown>>()
    const mainContents = {}
    const mainFrame = { url: 'http://127.0.0.1:3080/session' }
    const backend = {
      status: async () => 'active' as const,
      restart: async () => ({ origin: 'http://127.0.0.1:3080' as const }),
    }
    let closeRequests = 0

    registerDesktopIpc({
      handle: (channel, listener) => { handlers.set(channel, listener) },
    }, () => mainContents, () => mainFrame, backend, async () => { closeRequests += 1; return false })

    const status = handlers.get('dsh:backend-status')
    await expect(status?.({ sender: {}, senderFrame: mainFrame })).rejects.toThrow('Desktop IPC sender rejected')
    await expect(status?.({ sender: mainContents, senderFrame: { url: 'http://127.0.0.1:3080/frame' } })).rejects.toThrow('Desktop IPC sender rejected')
    await expect(status?.({ sender: mainContents, senderFrame: { url: 'https://example.com' } })).rejects.toThrow('Desktop IPC sender rejected')
    await expect(status?.({ sender: mainContents, senderFrame: mainFrame })).resolves.toBe('active')
    await expect(handlers.get('dsh:backend-restart')?.({ sender: mainContents, senderFrame: mainFrame })).resolves.toEqual({ origin: 'http://127.0.0.1:3080' })
    await expect(handlers.get('dsh:desktop-request-close')?.({ sender: mainContents, senderFrame: mainFrame })).resolves.toBe(false)
    expect(closeRequests).toBe(1)
  })

  it('exposes preload only in Electron main frames at the fixed Desktop origin', () => {
    expect(canExposePreloadApi(true, 'http://127.0.0.1:3080/')).toBe(true)
    expect(canExposePreloadApi(true, 'http://127.0.0.1:3081/')).toBe(false)
    expect(canExposePreloadApi(true, 'https://example.com/')).toBe(false)
    expect(canExposePreloadApi(false, 'http://127.0.0.1:3080/')).toBe(false)
    expect(canExposePreloadApi(true, 'not a URL')).toBe(false)
  })
})
