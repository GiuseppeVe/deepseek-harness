import { describe, expect, it } from 'vitest'
import ArtifactSidebarService from '../src/index.ts'

const config = {
  allowedRoots: [],
  allowedUrlOrigins: [],
  maxPreviewChars: 100,
  maxPins: 2,
  maxSourceLabelBytes: 20,
  maxPinNoteBytes: 20,
  maxDraftBytes: 20,
  maxSubmissionBytes: 100,
}

describe('ArtifactSidebarService configuration', () => {
  it('publishes explicit bounds through loader schema', () => {
    expect(ArtifactSidebarService.Config(config)).toEqual(config)
  })

  it('rejects missing explicit bounds', () => {
    expect(() => ArtifactSidebarService.Config({ allowedRoots: [] } as never)).toThrow()
  })
})
