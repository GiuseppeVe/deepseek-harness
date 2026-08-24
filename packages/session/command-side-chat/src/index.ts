/**
 * Ephemeral /side human command: forks a temporary side agent seeded with the
 * invoking conversation. The fork inherits the parent capabilities unchanged —
 * it is an ordinary chat with the same workspace-write permission surface —
 * and `/side-close` disposes it when the side panel closes.
 * @module @deepseek-ai/dsh-command-side-chat
 */

export const name = 'command-side-chat'
export const inject = ['commands', 'agentLoop']

interface Ctx { get(name: string): unknown; effect(fn: () => unknown, label: string): unknown }
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

function ownerKeyOf(invocation: Invocation): string {
  return invocation.agent.session.header.id ?? invocation.agent.id
}

async function openSideChat(ctx: Ctx, sideHandles: Map<string, SideHandle>, invocation: Invocation): Promise<CommandResult> {
  const parent = invocation.agent
  const ownerKey = ownerKeyOf(invocation)
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
    // prefix, which the browser window matches for discovery. No setup hooks:
    // the fork is an ordinary chat inheriting the parent preset, permissions
    // included (workspace write).
    const handle = await agentLoop.createAgent(parent.ctx, {
      sessionId,
      seed,
      meta: { cwd: parent.session.header.cwd, seedLength: seed.length },
      agentOptions: parent.options ?? {},
    })
    sideHandles.set(ownerKey, handle)
    return { kind: 'success', text: 'Side chat aperta a destra.' }
  } finally {
    sideCreating.delete(ownerKey)
  }
}

function closeSideChat(sideHandles: Map<string, SideHandle>, invocation: Invocation): CommandResult {
  const handle = sideHandles.get(ownerKeyOf(invocation))
  if (handle === undefined) return { kind: 'error', text: 'Nessuna side chat aperta.' }
  sideHandles.delete(ownerKeyOf(invocation))
  void handle.dispose().catch(() => { /* fork already gone */ })
  return { kind: 'success', text: 'Side chat chiusa.' }
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
  const commands = ctx.get('commands') as unknown as { register(d: unknown): () => void }
  ctx.effect(() => commands.register({
    name: 'side',
    description: 'Open an independent side chat forked from the current conversation.',
    handler: async (invocation: Invocation) => openSideChat(ctx, sideHandles, invocation),
  }), 'command-side-chat: /side')
  ctx.effect(() => commands.register({
    name: 'side-close',
    description: 'Close and dispose the side chat fork of the current conversation.',
    handler: async (invocation: Invocation) => closeSideChat(sideHandles, invocation),
  }), 'command-side-chat: /side-close')
}
