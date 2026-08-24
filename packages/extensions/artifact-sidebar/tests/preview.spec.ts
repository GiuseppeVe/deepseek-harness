import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { escapeText, readArtifactPreview, validateArtifactSource } from '../src/preview.ts'

describe('Artifact Sidebar preview policy', () => {
  it('escapes text and bounds preview characters', async () => {
    const root = join(tmpdir(), `artifact-sidebar-${Date.now()}-text`)
    await mkdir(root, { recursive: true })
    const path = join(root, 'note.txt')
    await writeFile(path, '<tag>&value', 'utf8')
    const result = await readArtifactPreview(
      { kind: 'local', path, label: 'note' },
      { allowedRoots: [root], allowedUrlOrigins: [], maxPreviewChars: 6 },
    )
    expect(result).toEqual({ ok: true, preview: { kind: 'text', text: '&lt;ta', truncated: true } })
    expect(escapeText('"\'&<>')).toBe('&quot;&#39;&amp;&lt;&gt;')
  })

  it('rejects parent segments and symlink escapes', async () => {
    const root = join(tmpdir(), `artifact-sidebar-${Date.now()}-root`)
    const outside = join(tmpdir(), `artifact-sidebar-${Date.now()}-outside`)
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    const outsidePath = join(outside, 'outside.txt')
    await writeFile(outsidePath, 'outside', 'utf8')
    const link = join(root, 'link.txt')
    await symlink(outsidePath, link)
    await expect(validateArtifactSource(
      { kind: 'local', path: join(root, '..', 'outside.txt'), label: 'escape' },
      { allowedRoots: [root], allowedUrlOrigins: [], maxPreviewChars: 20 },
    )).resolves.toMatchObject({ ok: false, code: 'source-path-not-allowed' })
    await expect(validateArtifactSource(
      { kind: 'local', path: link, label: 'link' },
      { allowedRoots: [root], allowedUrlOrigins: [], maxPreviewChars: 20 },
    )).resolves.toMatchObject({ ok: false, code: 'source-path-not-allowed' })
  })

  it('allows only configured HTTP(S) origins', async () => {
    await expect(validateArtifactSource(
      { kind: 'url', url: 'https://trusted.example/a.txt', label: 'remote' },
      { allowedRoots: [], allowedUrlOrigins: ['https://trusted.example'], maxPreviewChars: 20 },
    )).resolves.toMatchObject({ ok: true })
    await expect(validateArtifactSource(
      { kind: 'url', url: 'https://other.example/a.txt', label: 'remote' },
      { allowedRoots: [], allowedUrlOrigins: ['https://trusted.example'], maxPreviewChars: 20 },
    )).resolves.toMatchObject({ ok: false, code: 'source-origin-not-allowed' })
  })
})
