import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldArtifactSidebar } from '../src/fold.ts'
import { ArtifactPinId, ArtifactSubmissionId } from '../src/types.ts'
import type {
  ArtifactSidebarState,
  ArtifactSubmission,
} from '../src/types.ts'

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, data, seq, time: seq } as SessionEvent
}

function workspace(overrides: Partial<ArtifactSidebarState> = {}): ArtifactSidebarState {
  return {
    source: { kind: 'local', path: '/workspace/report.html', label: 'report.html' },
    draft: '',
    pins: [],
    ...overrides,
  }
}

function submission(id: string, state: ArtifactSidebarState): ArtifactSubmission {
  return { submissionId: ArtifactSubmissionId(id), state }
}

function queued(item: ArtifactSubmission, seq: number): SessionEvent {
  return event('artifact-sidebar/submission-queued', {
    submission: item,
    message: {
      id: `message-${item.submissionId}`,
      role: 'user',
      content: [{ type: 'text', text: 'Artifact Sidebar feedback' }],
      source: { kind: 'artifact-sidebar', submissionId: item.submissionId },
    },
  }, seq)
}

function delivered(submissionId: string, seq: number): SessionEvent {
  return event('user/message', {
    id: `delivered-${submissionId}`,
    role: 'user',
    content: [{ type: 'text', text: 'Artifact Sidebar feedback' }],
    source: { kind: 'artifact-sidebar', submissionId: ArtifactSubmissionId(submissionId) },
  }, seq)
}

describe('foldArtifactSidebar', () => {
  it('returns a frozen empty projection', () => {
    const projection = foldArtifactSidebar([])

    expect(projection).toEqual({
      source: null,
      draft: '',
      pins: [],
      pending: [],
    })
    expect(Object.isFrozen(projection)).toBe(true)
    expect(Object.isFrozen(projection.pins)).toBe(true)
    expect(Object.isFrozen(projection.pending)).toBe(true)
  })

  it('replaces the complete source, draft, and pin workspace snapshot', () => {
    const first = workspace({
      draft: 'first draft',
      pins: [{ id: ArtifactPinId('pin-1'), x: 10, y: 20, note: 'first pin' }],
    })
    const replacement = workspace({
      source: { kind: 'url', url: 'https://example.test/report', label: 'remote report' },
      draft: 'replacement draft',
      pins: [{ id: ArtifactPinId('pin-2'), x: 30, y: 40, note: 'replacement pin' }],
    })

    const projection = foldArtifactSidebar([
      event('artifact-sidebar/state', { state: first }, 1),
      event('artifact-sidebar/state', { state: replacement }, 2),
    ])

    expect(projection).toMatchObject({
      source: { kind: 'url', url: 'https://example.test/report', label: 'remote report' },
      draft: 'replacement draft',
      pins: [{ id: ArtifactPinId('pin-2'), x: 30, y: 40, note: 'replacement pin' }],
      pending: [],
    })
    expect(projection.source).not.toBe(replacement.source)
    expect(projection.pins).not.toBe(replacement.pins)
  })

  it('preserves ordered stable pin identifiers in the projected snapshot', () => {
    const pins = [
      { id: ArtifactPinId('pin-3'), x: 90, y: 10, note: 'third' },
      { id: ArtifactPinId('pin-1'), x: 10, y: 20, note: 'first' },
      { id: ArtifactPinId('pin-2'), x: 40, y: 50, note: 'second' },
    ]

    const projection = foldArtifactSidebar([
      event('artifact-sidebar/state', { state: workspace({ pins }) }, 1),
    ])

    expect(projection.pins.map(pin => pin.id)).toEqual([
      ArtifactPinId('pin-3'),
      ArtifactPinId('pin-1'),
      ArtifactPinId('pin-2'),
    ])
    expect(projection.pins[0]).not.toBe(pins[0])
    expect(Object.isFrozen(projection.pins[0])).toBe(true)
  })

  it('removes only the queued submission identified by its durable user message source', () => {
    const first = submission('submission-1', workspace({ draft: 'first' }))
    const second = submission('submission-2', workspace({ draft: 'second' }))

    const projection = foldArtifactSidebar([
      queued(first, 1),
      queued(second, 2),
      event('user/message', {
        id: 'ordinary-user-message',
        role: 'user',
        content: [{ type: 'text', text: 'ordinary feedback' }],
        source: { kind: 'user' },
      }, 3),
      delivered('submission-2', 4),
    ])

    expect(projection.pending).toEqual([first])
  })

  it('keeps the identical projection reference for unrelated and unmatched delivery events', () => {
    const projection = foldArtifactSidebar([])
    const unrelated = event('turn/start', { turn: 1 }, 1)
    const unmatched = delivered('submission-not-queued', 2)

    expect(foldArtifactSidebar([unrelated], projection)).toBe(projection)
    expect(foldArtifactSidebar([unmatched], projection)).toBe(projection)
  })
})
