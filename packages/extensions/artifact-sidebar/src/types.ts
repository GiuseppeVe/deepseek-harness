/** Client-safe durable values for Artifact Sidebar state and submissions. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identifier for one Artifact Sidebar annotation pin. */
export type ArtifactPinId = Branded<'ArtifactPinId'>

/**
 * Brand a generated Artifact Sidebar pin identifier.
 * @param id - generated pin identity.
 * @returns same string branded as a pin identifier.
 */
export function ArtifactPinId(id: string): ArtifactPinId {
  return id as ArtifactPinId
}

/** Stable identifier for one durable Artifact Sidebar feedback submission. */
export type ArtifactSubmissionId = Branded<'ArtifactSubmissionId'>

/**
 * Brand a generated Artifact Sidebar submission identifier.
 * @param id - generated submission identity.
 * @returns same string branded as a submission identifier.
 */
export function ArtifactSubmissionId(id: string): ArtifactSubmissionId {
  return id as ArtifactSubmissionId
}

/** Permitted local artifact selected for preview. */
export interface LocalArtifactSource {
  readonly kind: 'local'
  readonly path: string
  readonly label: string
}

/** Permitted HTTP(S) artifact selected for preview. */
export interface UrlArtifactSource {
  readonly kind: 'url'
  readonly url: string
  readonly label: string
}

/** Selected artifact reference retained in the session log, never preview bytes. */
export type ArtifactSource = LocalArtifactSource | UrlArtifactSource

/** One ordered annotation retained for an artifact preview. */
export interface ArtifactPin {
  readonly id: ArtifactPinId
  readonly x: number
  readonly y: number
  readonly note: string
}

/** Complete post-change annotation workspace retained by one session event. */
export interface ArtifactSidebarState {
  readonly source: ArtifactSource | null
  readonly draft: string
  readonly pins: readonly ArtifactPin[]
}

/** Complete feedback workspace retained until its matching user message is durable. */
export interface ArtifactSubmission {
  readonly submissionId: ArtifactSubmissionId
  readonly state: ArtifactSidebarState
}

/** Current durable Artifact Sidebar workspace with queued feedback submissions. */
export interface ArtifactSidebarProjection extends ArtifactSidebarState {
  readonly pending: readonly ArtifactSubmission[]
}
