/**
 * Persistent /side human command: forks an independent side agent seeded with
 * the invoking conversation, restricts its tools to a minimal read-only set
 * (best effort). @module @deepseek-ai/dsh-command-side-chat
 */

export const name = 'command-side-chat'
export const inject = ['commands', 'agentLoop']

interface Ctx { get(name: string): unknown; effect(fn: () => unknown, label: string): unknown }
interface AnyMessage { content?: Array<{ type?: string; text?: string }> }
interface SideEvent { type?: string; data?: { message?: AnyMessage } }
interface SideSession { header: { cwd?: string }; events: readonly SideEvent[]; firstLiveSeq?: number }
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
let sideHandle: SideHandle | undefined

async function openSideChat(ctx: Ctx, invocation: Invocation): Promise<CommandResult> {
  if (sideHandle !== undefined) {
    try { await sideHandle.dispose() } catch { /* previous fork already gone */ }
    sideHandle = undefined
  }
  const agentLoop = ctx.get('agentLoop') as AgentLoop | undefined
  if (agentLoop === undefined) return { kind: 'error', text: 'agentLoop service unavailable' }
  const parent = invocation.agent
  const events = parent.session.events
  const last = events[events.length - 1]
  const seed = last !== undefined && last.type === 'command/run' ? events.slice(0, -1) : events
  sideCounter += 1
  const sessionId = 'side-' + String(parent.id) + '-' + String(sideCounter) + '-' + String(Date.now())
  // No `origin: 'subagent'` and no `parentSession` header: either marks the
  // identity as subagent-owned and the API proxy fences `session.prompt`
  // (agent-lookup ownership check). The parent linkage rides the session id
  // prefix, which the browser window matches for discovery.
  sideHandle = await agentLoop.createAgent(parent.ctx, {
    sessionId,
    seed,
    meta: { cwd: parent.session.header.cwd, seedLength: seed.length },
    agentOptions: parent.options ?? {},
    setup: async (agentCtx: Ctx): Promise<void> => {
      const tools = ctx.get('tools') as { restrict(f: { allow: string[] }): () => void } | undefined
      if (tools !== undefined) {
        try { agentCtx.effect(() => tools.restrict({ allow: ['read', 'grep', 'glob'] }), 'side-minimal-tools') }
        catch { /* presentation without those global names: keep parent tools */ }
      }
    },
  })
  return { kind: 'success', text: 'Side chat aperta a destra.' }
}

export function apply(ctx: Ctx): void {
  ctx.effect(() => (ctx.get('commands') as unknown as { register(d: unknown): () => void }).register({
    name: 'side',
    description: 'Open an independent side chat forked from the current conversation.',
    handler: async (invocation: Invocation) => openSideChat(ctx, invocation),
  }), 'command-side-chat: /side')
}
