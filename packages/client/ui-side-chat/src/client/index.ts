/**
 * Browser half of ui-side-chat: fixed right column mirroring the main chat,
 * bound to the newest /side forked child of the current session. Discovery,
 * transcript, and delivery ride the ordinary session RPC surface — no
 * subagent-catalog membership required.
 * @module @deepseek-ai/dsh-client-ui-side-chat/client
 */
import { createElement, useEffect, useRef, useState } from 'react'

export const name = 'client-ui-side-chat'

const CSS = [
  '.scw-panel{position:fixed;top:0;right:0;bottom:0;width:min(480px,46vw);z-index:99999;display:flex;flex-direction:column;',
  'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-left:1px solid var(--dsw-alias-border-l1);',
  'box-shadow:-16px 0 40px rgba(0,0,0,.22);pointer-events:auto;font-size:14px}',
  '.scw-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.scw-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-secondary)}',
  '.scw-dot-on{background:var(--dsw-alias-state-success-primary)}',
  '.scw-title{font-weight:600;flex:1}',
  '.scw-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;cursor:pointer;padding:4px 8px;border-radius:6px}',
  '.scw-body{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:10px}',
  '.scw-empty{margin:auto;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center;max-width:280px;line-height:1.5}',
  '.scw-user{align-self:flex-end;background:var(--dsw-alias-brand-primary);color:#fff;border-radius:14px 14px 4px 14px;padding:9px 13px;white-space:pre-wrap;word-break:break-word;max-width:86%}',
  '.scw-assistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:14px 14px 14px 4px;padding:9px 13px;white-space:pre-wrap;word-break:break-word;max-width:86%}',
  '.scw-typing{align-self:flex-start;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 6px}',
  '.scw-compose{padding:12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.scw-card{display:flex;align-items:flex-end;gap:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:8px 8px 8px 12px}',
  '.scw-input{flex:1;resize:none;border:0;outline:0;background:transparent;color:inherit;font:inherit;max-height:140px;line-height:1.45}',
  '.scw-send{border:0;border-radius:10px;background:var(--dsw-alias-brand-primary);color:#fff;width:32px;height:32px;cursor:pointer;font-size:14px}'
].join('')

interface Row { role: 'user' | 'assistant'; text: string }

/** One wire entry of session.history: the session event plus its optional tool view. */
interface HistoryEntryWire { event?: { type?: string; data?: { content?: unknown } } }

/** Payload-direct session methods of the connection's IApiClient (RpcResponse envelopes). */
interface SessionApi {
  list(payload: Record<string, never>): Promise<unknown>
  history(payload: { sessionId: string; maxMessages?: number }): Promise<unknown>
  prompt(payload: { sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }> }): Promise<unknown>
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(b => (b !== null && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: string }).text ?? '') : '')).filter(Boolean).join('\n')
  }
  return ''
}

function rowsFromHistory(result: unknown): Row[] {
  const entries = (result as { events?: HistoryEntryWire[] })?.events
  if (!Array.isArray(entries)) return []
  const out: Row[] = []
  for (const entry of entries) {
    const event = entry?.event
    const text = textOf(event?.data?.content)
    if (text === '') continue
    if (event?.type === 'user/message') out.push({ role: 'user', text })
    else if (event?.type === 'assistant/message') out.push({ role: 'assistant', text })
  }
  return out
}

/** Peel an RPC response envelope ({result:{value}}) or a bare value. */
function unwrap<T>(value: unknown): T | undefined {
  const response = value as { result?: { ok?: boolean; error?: { message?: string }; value?: unknown }; value?: unknown }
  if (response !== null && typeof response === 'object' && response.result !== undefined) {
    if (response.result.ok === false) throw new Error(response.result.error?.message ?? 'rpc error')
    return response.result.value as T | undefined
  }
  return (response?.value !== undefined ? response.value : value) as T | undefined
}

/** Framework hook seat handed to every slot occupant by the renderer. */
interface SlotProps {
  useSessions?: (selector: (state: { current?: string }) => string | undefined) => string | undefined
}

function SideChatWindow(props: { useSessions?: SlotProps['useSessions']; getParent?: () => string | undefined; api?: SessionApi | undefined }): ReturnType<typeof createElement> | null {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [input, setInput] = useState('')
  const seenRef = useRef('')
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // Refs written during render mirror the previous deps pattern: the interval
  // closure reads the freshest values without re-subscribing.
  const apiRef = useRef<SessionApi | undefined>(props.api)
  apiRef.current = props.api
  const parentRef = useRef<string | undefined>(undefined)
  if (typeof props.useSessions === 'function') {
    parentRef.current = props.useSessions(state => state.current)
  }

  useEffect(function injectStyles(): void {
    let tag = document.getElementById('scw-styles') as HTMLStyleElement | null
    if (tag === null) { tag = document.createElement('style'); tag.id = 'scw-styles'; document.head.appendChild(tag) }
    tag.textContent = CSS
  }, [])

  useEffect(function poll(): () => void {
    let alive = true
    const tick = async (): Promise<void> => {
      const api = apiRef.current
      if (parentRef.current === undefined && typeof props.getParent === 'function') parentRef.current = props.getParent()
      const parent = parentRef.current
      if (api === undefined || parent === undefined) return
      try {
        const listed = unwrap<{ items?: Array<{ sessionId?: string; parentSessionId?: string }> }>(await api.list({}))
        const children = (listed?.items ?? []).filter(s =>
          typeof s.sessionId === 'string'
          && typeof s.parentSessionId === 'string'
          && s.parentSessionId === parent
          && s.sessionId.startsWith('side-'))
        if (children.length === 0) return
        const latest = children.map(s => s.sessionId!).sort((a, b) => (a < b ? -1 : 1))[children.length - 1]!
        if (latest !== seenRef.current) { seenRef.current = latest; if (alive) setOpen(true) }
        const history = unwrap<{ events?: HistoryEntryWire[] }>(await api.history({ sessionId: latest, maxMessages: 200 }))
        if (alive) setRows(rowsFromHistory(history))
      } catch { /* transient wire errors: retry next tick */ }
    }
    const timer = window.setInterval(() => void tick(), 700)
    void tick()
    return function(): void { alive = false; window.clearInterval(timer) }
  }, [])

  useEffect(function scroll(): void { if (bodyRef.current !== null) bodyRef.current.scrollTop = bodyRef.current.scrollHeight }, [rows.length])

  async function send(): Promise<void> {
    const text = input.trim()
    const api = apiRef.current
    if (text === '' || api === undefined || seenRef.current === '') return
    setInput('')
    try {
      await api.prompt({ sessionId: seenRef.current, mode: 'queue', content: [{ type: 'text', text }] })
    } catch { /* absence of a reply in the next poll surfaces the failure */ }
  }

  if (!open) return null
  const waiting = rows.length > 0 && rows[rows.length - 1]!.role === 'user'
  const body = rows.length === 0
    ? createElement('div', { className: 'scw-empty' }, 'Fork della conversazione corrente. Scrivi qui: la chat principale non viene modificata.')
    : rows.map((row, index) => createElement('div', { key: index, className: 'scw-' + row.role }, row.text))
  const typing = waiting ? createElement('div', { className: 'scw-typing' }, 'sta scrivendo…') : null
  return createElement('aside', { className: 'scw-panel' },
    createElement('header', { className: 'scw-head' },
      createElement('span', { className: 'scw-dot' + (waiting ? ' scw-dot-on' : '') }),
      createElement('span', { className: 'scw-title' }, 'Side chat'),
      createElement('button', { className: 'scw-close', title: 'Chiudi', onClick: () => setOpen(false) }, '\u2715')),
    createElement('main', { className: 'scw-body', ref: bodyRef }, body, typing),
    createElement('footer', { className: 'scw-compose' },
      createElement('div', { className: 'scw-card' },
        createElement('textarea', {
          className: 'scw-input', value: input, rows: 1,
          placeholder: 'Chiedi qualcosa nella side chat…',
          onChange: (e: { target: { value: string } }) => setInput(e.target.value),
          onKeyDown: (e: { key: string; shiftKey: boolean; preventDefault(): void }) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }
        }),
        createElement('button', { className: 'scw-send', title: 'Invia', onClick: () => void send() }, '\u27a4'))))
}

interface SlotFace {
  inject(key: string, cb: () => unknown): () => void
  register(options: Record<string, unknown>, render: (props: unknown) => unknown): unknown
}

export function apply(ctx: unknown): void {
  // Every dependency is an optional ctx.get read: a bare property access throws
  // outside a declared inject, so the half stays inject-free and gives up
  // silently after the retry budget when its services never appear.
  const c = ctx as { get?: (name: string) => unknown }
  const attempt = (tries: number): void => {
    const slots = c.get?.('slots') as SlotFace | undefined
    if (slots === undefined || typeof slots.inject !== 'function') {
      if (tries < 150) window.setTimeout(() => attempt(tries + 1), 200)
      return
    }
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'side-chat-window', order: 100 },
      (rawProps: unknown) => {
        const props = rawProps as { useSessions?: SlotProps['useSessions'] }
        const api = (c.get?.('connection') as { api?: { sessions?: SessionApi } } | undefined)?.api?.sessions
        // Fallback for occupants rendered with bare props: the sessions service
        // exposes its list store, whose snapshot carries the current id.
        const sessionsService = c.get?.('sessions') as { list?: { getSnapshot?: () => { current?: string } } } | undefined
        return createElement(SideChatWindow, {
          useSessions: props?.useSessions,
          getParent: () => sessionsService?.list?.getSnapshot?.().current,
          api,
        })
      },
    ))
  }
  attempt(0)
}
