/** Pure Artifact Sidebar projection from durable session events. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './domain.ts'
import type {
  ArtifactPin,
  ArtifactSidebarProjection,
  ArtifactSidebarState,
  ArtifactSource,
  ArtifactSubmission,
} from './types.ts'

const EMPTY_ARTIFACT_SIDEBAR = freezeProjection({
  source: null,
  draft: '',
  pins: [],
  pending: [],
})

/**
 * Fold durable Artifact Sidebar events from a session log.
 * @param events - ordered session events to apply.
 * @param from - prior projection returned by this fold, when incrementally replaying.
 * @returns frozen projection; unrelated events preserve `from` by reference.
 */
export function foldArtifactSidebar(
  events: readonly SessionEvent[],
  from: ArtifactSidebarProjection = EMPTY_ARTIFACT_SIDEBAR,
): ArtifactSidebarProjection {
  let projection = from
  for (const event of events) {
    projection = foldEvent(projection, event)
  }
  return projection
}

/** Copy and freeze one source retained by a projection. */
function freezeSource(source: ArtifactSource | null): ArtifactSource | null {
  return source === null ? null : Object.freeze({ ...source })
}

/** Copy and freeze one pin retained by a projection. */
function freezePin(pin: ArtifactPin): ArtifactPin {
  return Object.freeze({ ...pin })
}

/** Copy and freeze one complete post-change workspace snapshot. */
function freezeState(state: ArtifactSidebarState): ArtifactSidebarState {
  return Object.freeze({
    source: freezeSource(state.source),
    draft: state.draft,
    pins: Object.freeze(state.pins.map(freezePin)),
  })
}

/** Copy and freeze one durable feedback submission. */
function freezeSubmission(submission: ArtifactSubmission): ArtifactSubmission {
  return Object.freeze({
    submissionId: submission.submissionId,
    state: freezeState(submission.state),
  })
}

/** Copy and freeze a complete projection state. */
function freezeProjection(projection: ArtifactSidebarProjection): ArtifactSidebarProjection {
  const state = freezeState(projection)
  return Object.freeze({
    ...state,
    pending: Object.freeze(projection.pending.map(freezeSubmission)),
  })
}

/** Apply one recognized Artifact Sidebar event or its matching delivery message. */
function foldEvent(
  projection: ArtifactSidebarProjection,
  event: SessionEvent,
): ArtifactSidebarProjection {
  switch (event.type) {
    case 'artifact-sidebar/state':
      return freezeProjection({ ...event.data.state, pending: projection.pending })
    case 'artifact-sidebar/submission-queued':
      return freezeProjection({
        ...projection,
        pending: [...projection.pending, event.data.submission],
      })
    case 'user/message': {
      const source = event.data.source
      if (source.kind !== 'artifact-sidebar') return projection
      const pending = projection.pending.filter(submission => submission.submissionId !== source.submissionId)
      return pending.length === projection.pending.length
        ? projection
        : freezeProjection({ ...projection, pending })
    }
    default:
      return projection
  }
}
