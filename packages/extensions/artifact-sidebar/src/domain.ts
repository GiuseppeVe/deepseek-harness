/** Host-side Artifact Sidebar session-log and message attribution vocabulary. */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ArtifactSidebarState,
  ArtifactSubmission,
  ArtifactSubmissionId,
} from './types.ts'

/** Source recorded on model-visible feedback submitted from Artifact Sidebar. */
export interface ArtifactSidebarMessageSource {
  readonly kind: 'artifact-sidebar'
  readonly submissionId: ArtifactSubmissionId
}

/** Complete bounded workspace snapshot appended after one accepted sidebar edit. */
export interface ArtifactSidebarStateEvent {
  readonly state: ArtifactSidebarState
}

/** Durable outbox record appended before steering its ordinary user message. */
export interface ArtifactSidebarSubmissionQueuedEvent {
  readonly submission: ArtifactSubmission
  readonly message: UserMessage
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'artifact-sidebar': ArtifactSidebarMessageSource
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete bounded post-change workspace snapshot; append with `ignorable: true`. */
    'artifact-sidebar/state': ArtifactSidebarStateEvent
    /** Complete bounded outbox record; append with `ignorable: true`. */
    'artifact-sidebar/submission-queued': ArtifactSidebarSubmissionQueuedEvent
  }
}
