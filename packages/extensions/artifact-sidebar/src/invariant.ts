/** Package-owned invariant for Artifact Sidebar durable event payloads. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { z as zod } from 'zod'

const PACKAGE_NAME = '@deepseek-ai/dsh-artifact-sidebar'

/** Cordis companion plugin name. */
export const name = 'artifact-sidebar-invariant'
/** Service required before companion installation. */
export const inject = ['invariants']

const sourceSchema = zod.union([
  zod.object({ kind: zod.literal('local'), path: zod.string().min(1), label: zod.string() }).strict(),
  zod.object({ kind: zod.literal('url'), url: zod.string().min(1), label: zod.string() }).strict(),
]).nullable()
const pinSchema = zod.object({
  id: zod.string().min(1),
  x: zod.number().finite(),
  y: zod.number().finite(),
  note: zod.string(),
}).strict()
const stateSchema = zod.object({ source: sourceSchema, draft: zod.string(), pins: zod.array(pinSchema) }).strict()
const submissionSchema = zod.object({
  submissionId: zod.string().min(1),
  state: stateSchema,
}).strict()

/** Decode one Artifact Sidebar event and reject malformed durable payloads. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'artifact-sidebar/state') {
    const result = zod.object({ state: stateSchema }).strict().safeParse(event.data)
    if (!result.success) fail(`artifact-sidebar event ${String(event.seq)} has invalid state payload`)
    else validateState(result.data.state, event.seq, fail)
  } else if (event.type === 'artifact-sidebar/submission-queued') {
    const result = zod.object({
      submission: submissionSchema,
      message: zod.object({
        source: zod.object({ kind: zod.literal('artifact-sidebar'), submissionId: zod.string().min(1) }).passthrough(),
      }).passthrough(),
    }).strict().safeParse(event.data)
    if (!result.success) fail(`artifact-sidebar event ${String(event.seq)} has invalid queued-submission payload`)
    else {
      validateState(result.data.submission.state, event.seq, fail)
      if (result.data.message.source.submissionId !== result.data.submission.submissionId) {
        fail(`artifact-sidebar event ${String(event.seq)} queued message identity does not match submission`)
      }
    }
  } else if (event.type === 'user/message') {
    const source = event.data.source
    if (typeof source === 'object' && source !== null && 'kind' in source && source.kind === 'artifact-sidebar') {
      if (!('submissionId' in source) || typeof source.submissionId !== 'string' || source.submissionId.length === 0) {
        fail(`artifact-sidebar message ${String(event.seq)} has invalid submission identity`)
      }
    }
  }
}

/** Check durable state relations independent of service presence or config. */
function validateState(state: zod.infer<typeof stateSchema>, seq: number, fail: InvariantFailure): void {
  const ids = new Set<string>()
  for (const pin of state.pins) {
    if (pin.note.trim().length === 0) fail(`artifact-sidebar event ${String(seq)} contains a blank pin note`)
    if (ids.has(pin.id)) fail(`artifact-sidebar event ${String(seq)} contains duplicate pin id ${JSON.stringify(pin.id)}`)
    ids.add(pin.id)
  }
}

/** Install an independent event-stream validator over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const staged = new WeakSet<SessionEvent>()
  const seed = (session: Session): void => {
    for (const event of session.events) validateEvent(event, fail)
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', seed, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = args[1] as SessionEvent
    validateEvent(event, fail)
    staged.add(event)
  }, { global: true })
  ctx.on('session/event', (_session, event) => {
    if (!staged.delete(event)) fail(`artifact-sidebar event ${String(event.seq)} bypassed invariant validation`)
  }, { global: true })
}, { inject: ['sessions'] })

/** Register Artifact Sidebar invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
