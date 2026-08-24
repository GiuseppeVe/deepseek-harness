/**
 * Persistent /side human command: forks an independent side agent seeded with
 * the invoking conversation, restricts its tools to a minimal read-only set
 * (best effort). @module @deepseek-ai/dsh-command-side-chat
 */

export const name = 'command-side-chat'
export const inject = ['commands', 'agentLoop']

interface Ctx { get(name: string): unknown; effect(fn: () => unknown, label: string): unknown; tools?: { restrict(f: { allow: string[] }): () => void } | undefined }
interface AnyMessage { content?: Array<{ type?: string; text?: string }> }
interface SideEvent { type?: string; data?: { message?: AnyMessage } }
interface SideSession { header: { id?: string; cwd?: string }; events: readonly SideEvent[]; firstLiveSeq?: number }
interface SideAgent {
  id: string
  options?: Record<string, unknown>
  session: SideSession
  followup(message: unknown): void
}
interface SideHandle { agent: SideAgent; dispose(): Promise<void> }
interface AgentLoop {
  createAgent(owner: Ctx, options: Record<string, unknown>): Promise<SideHandle>
}
interface Invocation {
  agent: { id: string; options?: Record<string, unknown>; ctx: Ctx; session: SideSession }
  rawInput: string
}
interface CommandResult { kind: 'success' | 'error'; text: string }

let sideCounter = 0
/** Owner keys with a fork creation in flight: a second `/side` while the
 * first `createAgent` awaits would orphan one handle forever. */
const sideCreating = new Set<string>()

async function openSideChat(ctx: Ctx, sideHandles: Map<string, SideHandle>, invocation: Invocation): Promise<CommandResult> {
  const parent = invocation.agent
  const ownerKey = parent.session.header.id ?? parent.id
  if (sideCreating.has(ownerKey)) return { kind: 'error', text: 'Creazione della side chat già in corso.' }
  sideCreating.add(ownerKey)
  try {
    const previous = sideHandles.get(ownerKey)
    if (previous !== undefined) {
      try { await previous.dispose() } catch { /* previous fork already gone */ }
      sideHandles.delete(ownerKey)
    }
    const agentLoop = ctx.get('agentLoop') as AgentLoop | undefined
    if (agentLoop === undefined) return { kind: 'error', text: 'agentLoop service unavailable' }
    const events = parent.session.events
    const last = events[events.length - 1]
    const seed = last !== undefined && last.type === 'command/run' ? events.slice(0, -1) : events
    sideCounter += 1
    const sessionId = 'side-' + String(parent.id) + '-' + String(sideCounter) + '-' + String(Date.now())
    // No `origin: 'subagent'` and no `parentSession` header: either marks the
    // identity as subagent-owned and the API proxy fences `session.prompt`
    // (agent-lookup ownership check). The parent linkage rides the session id
    // prefix, which the browser window matches for discovery.
    const handle = await agentLoop.createAgent(parent.ctx, {
      sessionId,
      seed,
      meta: { cwd: parent.session.header.cwd, seedLength: seed.length },
      agentOptions: parent.options ?? {},
      setup: async (agentCtx: Ctx): Promise<void> => {
        // restrict() exists only on the agent-scoped tools view; the global
        // service instance throws. Failing loud beats a side chat that keeps
        // every parent tool silently.
        const tools = (agentCtx as Ctx).tools
        if (tools === undefined) throw new Error('side chat: agent context exposes no scoped tools service')
        agentCtx.effect(() => tools.restrict({ allow: ['read', 'grep', 'glob'] }), 'side-minimal-tools')
      },
    })
    sideHandles.set(ownerKey, handle)
    return { kind: 'success', text: 'Side chat aperta a destra.' }
  } finally {
    sideCreating.delete(ownerKey)
  }
}

export function apply(ctx: Ctx): void {
  const sideHandles = new Map<string, SideHandle>()
  ctx.effect(() => async () => {
    const handles = [...sideHandles.values()]
    sideHandles.clear()
    await Promise.all(handles.map(async handle => {
      try { await handle.dispose() } catch { /* fork already gone */ }
    }))
  }, 'command-side-chat: dispose side chats')
  ctx.effect(() => (ctx.get('commands') as unknown as { register(d: unknown): () => void }).register({
    name: 'side',
    description: 'Open an independent side chat forked from the current conversation.',
    handler: async (invocation: Invocation) => openSideChat(ctx, sideHandles, invocation),
  }), 'command-side-chat: /side')
}
