/** Static Host service for durable Artifact Sidebar state and transient previews. */

import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z as zod } from 'zod'
import { foldArtifactSidebar } from './fold.ts'
import type { ArtifactSidebarProjection, ArtifactSidebarState, ArtifactSource } from './types.ts'
import { readArtifactPreview, utf8Bytes, validateArtifactSource } from './preview.ts'
import type { ArtifactPreview, PreviewFailureCode } from './preview.ts'

export type * from './types.ts'
export type * from './domain.ts'
export { foldArtifactSidebar } from './fold.ts'
export { escapeText, readArtifactPreview, validateArtifactSource } from './preview.ts'
export type { ArtifactPreview, ArtifactSrcdocPreview, ArtifactTextPreview } from './preview.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    artifactSidebar: ArtifactSidebarService
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    artifactSidebar: ArtifactSidebarProjection
  }
  interface SessionProjectionMap {
    artifactSidebar: ArtifactSidebarProjection
  }
}

/** Deployment policy for source, preview, and durable-state bounds. */
export interface Config {
  readonly allowedRoots: string[]
  readonly allowedUrlOrigins: string[]
  readonly maxPreviewChars: number
  readonly maxPins: number
  readonly maxSourceLabelBytes: number
  readonly maxPinNoteBytes: number
  readonly maxDraftBytes: number
  readonly maxSubmissionBytes: number
}

/** Stable business failure returned by browser-facing state operations. */
export interface ArtifactSidebarFailure {
  readonly code: ArtifactSidebarErrorCode
  readonly message?: string
  readonly max?: number
  readonly actual?: number
}

/** Browser-visible validation and source-read failure codes. */
export type ArtifactSidebarErrorCode =
  | 'agent-not-live'
  | 'invalid-state'
  | 'blank-pin-note'
  | 'pin-note-too-large'
  | 'draft-too-large'
  | 'too-many-pins'
  | 'source-label-too-large'
  | 'submission-too-large'
  | PreviewFailureCode

/** Result union used by browser-to-Host calls. */
export type ArtifactSidebarResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ArtifactSidebarFailure }

/** State replacement result. */
export type ArtifactSidebarStateResult = ArtifactSidebarResult<ArtifactSidebarProjection>

/** Preview read result. */
export type ArtifactSidebarPreviewResult = ArtifactSidebarResult<ArtifactPreview>

const sourceSchema = zod.union([
  zod.object({ kind: zod.literal('local'), path: zod.string(), label: zod.string() }).strict(),
  zod.object({ kind: zod.literal('url'), url: zod.string(), label: zod.string() }).strict(),
]).nullable()

const pinSchema = zod.object({
  id: zod.string().min(1),
  x: zod.number().finite(),
  y: zod.number().finite(),
  note: zod.string(),
}).strict()

const stateSchema: zod.ZodType<ArtifactSidebarState> = zod.object({
  source: sourceSchema,
  draft: zod.string(),
  pins: zod.array(pinSchema),
}).strict() as unknown as zod.ZodType<ArtifactSidebarState>

const projectionSchema: zod.ZodType<ArtifactSidebarProjection> = zod.object({
  source: sourceSchema,
  draft: zod.string(),
  pins: zod.array(pinSchema),
  pending: zod.array(zod.object({
    submissionId: zod.string().min(1),
    state: stateSchema,
  }).strict()),
}).strict() as unknown as zod.ZodType<ArtifactSidebarProjection>

/** Validate one positive deployment bound. */
function positiveBound(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`artifact-sidebar: ${name} must be a positive safe integer`)
  return value
}

/** Validate and detach one configured URL origin. */
function normalizeOrigin(origin: string): string {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new TypeError(`artifact-sidebar: invalid URL origin ${JSON.stringify(origin)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' || parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new TypeError(`artifact-sidebar: URL origin must be HTTP(S) origin ${JSON.stringify(origin)}`)
  }
  return parsed.origin
}

/** Validate complete service configuration at load. */
function resolveConfig(config: Config): Config {
  if (!Array.isArray(config.allowedRoots) || config.allowedRoots.some(root => typeof root !== 'string' || root.length === 0)) {
    throw new TypeError('artifact-sidebar: allowedRoots must contain non-empty paths')
  }
  if (!Array.isArray(config.allowedUrlOrigins)) throw new TypeError('artifact-sidebar: allowedUrlOrigins must be an array')
  return Object.freeze({
    allowedRoots: Object.freeze([...config.allowedRoots]),
    allowedUrlOrigins: Object.freeze([...config.allowedUrlOrigins].map(normalizeOrigin)),
    maxPreviewChars: positiveBound('maxPreviewChars', config.maxPreviewChars),
    maxPins: positiveBound('maxPins', config.maxPins),
    maxSourceLabelBytes: positiveBound('maxSourceLabelBytes', config.maxSourceLabelBytes),
    maxPinNoteBytes: positiveBound('maxPinNoteBytes', config.maxPinNoteBytes),
    maxDraftBytes: positiveBound('maxDraftBytes', config.maxDraftBytes),
    maxSubmissionBytes: positiveBound('maxSubmissionBytes', config.maxSubmissionBytes),
  }) as unknown as Config
}

/** Copy projection before exposing it to an RPC caller. */
function copyProjection(projection: ArtifactSidebarProjection): ArtifactSidebarProjection {
  return {
    source: projection.source === null ? null : { ...projection.source },
    draft: projection.draft,
    pins: projection.pins.map(pin => ({ ...pin })),
    pending: projection.pending.map(item => ({
      submissionId: item.submissionId,
      state: {
        source: item.state.source === null ? null : { ...item.state.source },
        draft: item.state.draft,
        pins: item.state.pins.map(pin => ({ ...pin })),
      },
    })),
  }
}

/** Construct one business failure. */
function failure(code: ArtifactSidebarErrorCode, message: string, extra: Partial<ArtifactSidebarFailure> = {}): ArtifactSidebarFailure {
  return { code, message, ...extra }
}

/** Static Artifact Sidebar Host service. */
export class ArtifactSidebarService extends TypertRemoteService {
  static inject = ['agents']

  static Config: s<Config> = s.object({
    allowedRoots: s.array(s.string()).required(),
    allowedUrlOrigins: s.array(s.string()).required(),
    maxPreviewChars: s.number().step(1).min(1).required(),
    maxPins: s.number().step(1).min(1).required(),
    maxSourceLabelBytes: s.number().step(1).min(1).required(),
    maxPinNoteBytes: s.number().step(1).min(1).required(),
    maxDraftBytes: s.number().step(1).min(1).required(),
    maxSubmissionBytes: s.number().step(1).min(1).required(),
  })

  private readonly config: Config

  /**
   * @param ctx - Host context containing the live-agent registry.
   * @param config - explicit deployment bounds and source policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'artifactSidebar')
    this.config = resolveConfig(config)
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register({
        key: 'artifactSidebar',
        stateSchema: projectionSchema,
        init: (): ArtifactSidebarProjection => ({ source: null, draft: '', pins: [], pending: [] }),
        apply: (state, event) => foldArtifactSidebar([event], state),
        wire: { viewSchema: projectionSchema, view: state => state },
        stateVersion: 1,
      })
    })
  }

  /** Return current durable state and pending submissions for one live Agent. */
  @Remote('state')
  state(agent: Agent): ArtifactSidebarProjection {
    if (!this.isLive(agent)) throw new Error(`artifact-sidebar: agent "${agent.id}" is not live`)
    return copyProjection(foldArtifactSidebar(agent.session.events))
  }

  /**
   * Validate and append one complete bounded state replacement.
   * @param agent - exact live Agent owning the session log.
   * @param state - browser-provided complete state replacement.
   * @returns committed projection or a stable validation failure.
   */
  @Remote('setState')
  async setState(agent: Agent, state: ArtifactSidebarState): Promise<ArtifactSidebarStateResult> {
    if (!this.isLive(agent)) return { ok: false, error: failure('agent-not-live', 'agent is not live') }
    const validated = await this.validateState(state)
    if (!validated.ok) return validated
    agent.session.append('artifact-sidebar/state', { state: validated.value })
    return { ok: true, value: this.state(agent) }
  }

  /** Read bounded transient preview; preview bytes never enter session state. */
  @Remote('readPreview')
  async readPreview(agent: Agent, source: ArtifactSource): Promise<ArtifactSidebarPreviewResult> {
    if (!this.isLive(agent)) return { ok: false, error: failure('agent-not-live', 'agent is not live') }
    if (!this.validSourceLabel(source)) return { ok: false, error: failure('source-label-too-large', 'source label exceeds configured byte limit', { max: this.config.maxSourceLabelBytes }) }
    const result = await readArtifactPreview(source, this.config)
    return result.ok
      ? { ok: true, value: result.preview }
      : { ok: false, error: failure(result.code, result.message) }
  }

  /** Runtime-check and bound browser-provided state before append. */
  private async validateState(value: unknown): Promise<ArtifactSidebarResult<ArtifactSidebarState>> {
    const parsed = stateSchema.safeParse(value)
    if (!parsed.success) return { ok: false, error: failure('invalid-state', 'state fields are invalid') }
    const state = parsed.data
    if (state.pins.length > this.config.maxPins) return { ok: false, error: failure('too-many-pins', 'pin count exceeds configured limit', { max: this.config.maxPins, actual: state.pins.length }) }
    const draftBytes = utf8Bytes(state.draft)
    if (draftBytes > this.config.maxDraftBytes) return { ok: false, error: failure('draft-too-large', 'draft exceeds configured byte limit', { max: this.config.maxDraftBytes, actual: draftBytes }) }
    for (const pin of state.pins) {
      if (pin.note.trim().length === 0) return { ok: false, error: failure('blank-pin-note', 'pin note must not be blank') }
      const bytes = utf8Bytes(pin.note)
      if (bytes > this.config.maxPinNoteBytes) return { ok: false, error: failure('pin-note-too-large', 'pin note exceeds configured byte limit', { max: this.config.maxPinNoteBytes, actual: bytes }) }
    }
    if (state.source !== null) {
      if (!this.validSourceLabel(state.source)) return { ok: false, error: failure('source-label-too-large', 'source label exceeds configured byte limit', { max: this.config.maxSourceLabelBytes }) }
      const source = await validateArtifactSource(state.source, this.config)
      if (!source.ok) return { ok: false, error: failure(source.code, source.message) }
    }
    const snapshot = Object.freeze({
      source: state.source === null ? null : Object.freeze({ ...state.source }),
      draft: state.draft,
      pins: Object.freeze(state.pins.map(pin => Object.freeze({ ...pin }))),
    })
    return { ok: true, value: snapshot }
  }

  private validSourceLabel(source: unknown): source is ArtifactSource {
    return typeof source === 'object' && source !== null && 'label' in source
      && typeof source.label === 'string' && utf8Bytes(source.label) <= this.config.maxSourceLabelBytes
  }

  private isLive(agent: Agent): boolean {
    return this.ctx.agents.get(agent.id) === agent
  }
}

export default ArtifactSidebarService
