/**
 * Browser half of ui-side-chat: fixed right column mirroring the main chat,
 * bound to the newest /side forked child of the current session. Discovery,
 * transcript, and delivery ride the ordinary session RPC surface — no
 * subagent-catalog membership required. Opening is visually clean: the seeded
 * parent context stays internal until this side conversation produces its own
 * messages. Styling consumes only --dsw-* theme tokens.
 * @module @deepseek-ai/dsh-client-ui-side-chat/client
 */
import { createElement, useEffect, useRef, useState } from 'react'

export const name = 'client-ui-side-chat'

const CSS = [
  '.scw-panel{position:fixed;top:0;right:0;bottom:0;width:min(420px,44vw);z-index:99999;display:flex;flex-direction:column;',
  'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-left:1px solid var(--dsw-alias-border-l2);',
  'box-shadow:var(--dsw-shadow-lv2);font-family:var(--dsw-font-family)}',
  '.scw-head{display:flex;align-items:center;gap:10px;padding:0 12px 0 16px;height:50px;flex:none;',
  'border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.scw-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-dimmed);flex:none}',
  '.scw-dot-on{background:var(--dsw-alias-state-success-primary)}',
  '.scw-title{font-weight:600;font-size:14px;line-height:20px;flex:1;color:var(--dsw-alias-label-primary)}',
  '.scw-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;',
  'width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px}',
  '.scw-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.scw-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}',
  '.scw-empty{margin:auto;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:center;max-width:300px}',
  '.scw-row{max-width:88%;padding:9px 13px;font-size:14px;line-height:22px;white-space:pre-wrap;word-break:break-word}',
  '.scw-user{align-self:flex-end;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);',
  'border-radius:14px 14px 4px 14px}',
  '.scw-assistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);',
  'color:var(--dsw-alias-label-primary);border-radius:14px 14px 14px 4px}',
  '.scw-typing{align-self:flex-start;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px;padding:2px 4px}',
  '.scw-compose{flex:none;padding:12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
  '.scw-card{display:flex;align-items:flex-end;gap:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);',
  'border-radius:16px;padding:7px 7px 7px 13px}',
  '.scw-card:focus-within{border-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-shadow-lv1)}',
  '.scw-input{flex:1;resize:none;border:0;outline:0;background:transparent;color:inherit;font-family:inherit;',
  'font-size:14px;line-height:20px;max-height:132px;padding:5px 0}',
  '.scw-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
  '.scw-send{border:0;border-radius:10px;width:30px;height:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
  'font-size:13px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}',
  '.scw-send:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
  '.scw-send:disabled{background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-secondary);cursor:default}'
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
  // Fresh-fork mark: while the newest fork has not produced its own transcript,
  // the body stays clean even though the seeded context loaded internally.
  const baselineRef = useRef(0)
  const freshRef = useRef({ fork: '', done: false })
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
        if (latest !== seenRef.current) {
          seenRef.current = latest
          freshRef.current = { fork: latest, done: false }
          baselineRef.current = 0
          if (alive) setOpen(true)
        }
        const history = unwrap<{ events?: HistoryEntryWire[] }>(await api.history({ sessionId: latest, maxMessages: 200 }))
        const allRows = rowsFromHistory(history)
        if (freshRef.current.fork === latest && !freshRef.current.done) {
          baselineRef.current = allRows.length
          freshRef.current.done = true
        }
        if (alive) setRows(allRows)
      } catch { /* transient wire errors: retry next tick */ }
    }
    const timer = window.setInterval(() => void tick(), 700)
    void tick()
    return function(): void { alive = false; window.clearInterval(timer) }
  }, [])

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
  const shown = rows.slice(baselineRef.current)
  const waiting = rows.length > 0 && rows[rows.length - 1]!.role === 'user'
  const canSend = input.trim() !== '' && seenRef.current !== ''
  const body = shown.length === 0
    ? createElement('div', { className: 'scw-empty' }, 'Fork della conversazione corrente con il suo contesto precaricato. Scrivi qui: la chat principale non viene modificata.')
    : shown.map((row, index) => createElement('div', { key: index, className: 'scw-row scw-' + row.role }, row.text))
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
        createElement('button', { className: 'scw-send', title: 'Invia', disabled: !canSend, onClick: () => void send() }, '\u27a4'))))
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
