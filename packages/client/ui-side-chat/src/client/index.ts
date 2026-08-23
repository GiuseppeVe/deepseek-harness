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

interface Row { role: 'user' | 'assistant'; text: string; seq: number }

/** One wire entry of session.history: the session event plus its optional tool view. */
interface HistoryEntryWire {
  event?: {
    type?: string
    seq?: number
    time?: number
    data?: { content?: unknown; message?: { content?: unknown } }
  }
}

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
  // Stream-aware fold: text-delta chunks accumulate into a provisional
  // assistant row so replies grow live like the main chat, and the final
  // assistant/message replaces them.
  let streaming = ''
  let lastSeq = 0
  for (const entry of entries) {
    const event = entry?.event
    if (event === undefined) continue
    const seq = typeof event.seq === 'number' ? event.seq : lastSeq
    lastSeq = seq
    if (event.type === 'assistant/chunk') {
      const chunk = (event.data as { chunk?: { type?: string; text?: string } } | undefined)?.chunk
      if (chunk !== undefined && chunk.type === 'text-delta' && typeof chunk.text === 'string') streaming += chunk.text
      continue
    }
    // user/message carries the message directly; assistant/message wraps it in
    // a `message` field beside turn/step/usage.
    const data = event?.data
    const text = textOf(data?.content ?? data?.message?.content)
    if (event.type === 'user/message') {
      streaming = ''
      if (text !== '') out.push({ role: 'user', text, seq })
    } else if (event.type === 'assistant/message') {
      if (text !== '') out.push({ role: 'assistant', text, seq })
      else if (streaming !== '') out.push({ role: 'assistant', text: streaming, seq })
      streaming = ''
    }
  }
  if (streaming !== '') out.push({ role: 'assistant', text: streaming + ' \u258d', seq: lastSeq })
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
  // Optimistic local echo of our own sends: the bubble appears instantly and
  // the poller's confirmed row retires it.
  const [echoes, setEchoes] = useState<Row[]>([])
  // Four-second visible cue that the poller re-bound to a freshly created
  // fork: with a clean open, an already-open window would otherwise show no
  // change at all when /side runs.
  const [announce, setAnnounce] = useState(false)
  const seenRef = useRef('')
  // Visibility cut: rows whose event seq is at or below the cut belong to the
  // seeded context and stay hidden. The cut is taken from the first history
  // window fetched after binding, so the transcript starts clean regardless
  // of how large the seed is. Position-independent: a sliding tail window
  // cannot resurrect hidden rows.
  const cutSeqRef = useRef<number | null>(null)
  const updatedAtRef = useRef(0)
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
        const listed = unwrap<{ items?: Array<{ sessionId?: string; updatedAt?: number }> }>(await api.list({}))
        const prefix = 'side-' + parent + '-'
        const children = (listed?.items ?? []).filter(s =>
          typeof s.sessionId === 'string' && s.sessionId.startsWith(prefix))
        if (children.length === 0) return
        const latestRow = children
          .map(s => ({ id: s.sessionId!, updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0 }))
          .sort((a, b) => (a.id < b.id ? -1 : 1))[children.length - 1]!
        const latest = latestRow.id
        if (latest !== seenRef.current) {
          seenRef.current = latest
          updatedAtRef.current = latestRow.updatedAt
          cutSeqRef.current = null
          if (alive) { setRows([]); setOpen(true); setAnnounce(true); window.setTimeout(() => { if (alive) setAnnounce(false) }, 4000) }
        }
        // The seed replays the whole parent conversation, so a full-history
        // fetch costs megabytes: pull the tail window only when the fork log
        // actually moved.
        if (latestRow.updatedAt !== updatedAtRef.current || cutSeqRef.current === null) {
          updatedAtRef.current = latestRow.updatedAt
          const history = unwrap<{ events?: HistoryEntryWire[] }>(await api.history({ sessionId: latest, maxMessages: 40 }))
          const allRows = rowsFromHistory(history)
          if (cutSeqRef.current === null) {
            const last = allRows[allRows.length - 1]
            cutSeqRef.current = last !== undefined ? last.seq : -1
          }
          if (alive) {
            // A confirmed user row retires its optimistic echo.
            setEchoes(prev => prev.filter(echo => !allRows.some(row => row.role === 'user' && row.text === echo.text)))
            setRows(allRows)
          }
        }
      } catch { /* transient wire errors: retry next tick */ }
    }
    const timer = window.setInterval(() => void tick(), 400)
    void tick()
    return function(): void { alive = false; window.clearInterval(timer) }
  }, [])

  // Keep the tail in view while history rows or echoes land.
  useEffect(function keepTail(): void {
    if (bodyRef.current !== null) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [rows, echoes])

  async function send(): Promise<void> {
    const text = input.trim()
    const api = apiRef.current
    if (text === '' || api === undefined || seenRef.current === '') return
    setInput('')
    setEchoes(prev => [...prev, { role: 'user', text, seq: Number.MAX_SAFE_INTEGER }])
    try {
      await api.prompt({ sessionId: seenRef.current, mode: 'queue', content: [{ type: 'text', text }] })
    } catch {
      setEchoes(prev => prev.filter(echo => echo.text !== text))
      /* absence of a reply in the next poll surfaces the failure */
    }
  }

  if (!open) return null
  const cut = cutSeqRef.current ?? 0
  const visible = [...rows.filter(row => row.seq > cut), ...echoes]
  const waiting = visible.length > 0 && visible[visible.length - 1]!.role === 'user'
  const canSend = input.trim() !== '' && seenRef.current !== ''
  const body = visible.map((row, index) => createElement('div', { key: index, className: 'scw-row scw-' + row.role }, row.text))
  const typing = waiting ? createElement('div', { className: 'scw-typing' }, 'sta scrivendo…') : null
  return createElement('aside', { className: 'scw-panel' },
    createElement('header', { className: 'scw-head' },
      createElement('span', { className: 'scw-dot' + ((waiting || announce) ? ' scw-dot-on' : '') }),
      createElement('span', { className: 'scw-title' }, announce ? 'Side chat \u2014 nuova fork pronta' : 'Side chat'),
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
