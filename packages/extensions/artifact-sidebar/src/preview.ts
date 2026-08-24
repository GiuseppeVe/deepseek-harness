/** Bounded, non-durable Artifact Sidebar preview reads. */

import { readFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import type { ArtifactSource, LocalArtifactSource, UrlArtifactSource } from './types.ts'

/** Preview returned for HTML and SVG sources. */
export interface ArtifactSrcdocPreview {
  readonly kind: 'srcdoc'
  readonly srcdoc: string
  readonly truncated: boolean
}

/** Preview returned for ordinary text sources. */
export interface ArtifactTextPreview {
  readonly kind: 'text'
  readonly text: string
  readonly truncated: boolean
}

/** Host preview response. Preview contents are never part of durable state. */
export type ArtifactPreview = ArtifactSrcdocPreview | ArtifactTextPreview

/** Preview policy needed by source validation and bounded reads. */
export interface PreviewPolicy {
  readonly allowedRoots: readonly string[]
  readonly allowedUrlOrigins: readonly string[]
  readonly maxPreviewChars: number
}

/** Source-read failure with a stable browser-visible code. */
export type PreviewFailureCode =
  | 'source-path-not-allowed'
  | 'source-unavailable'
  | 'source-origin-not-allowed'
  | 'source-scheme-not-allowed'
  | 'source-invalid'
  | 'preview-read-failed'

/** Validate one source without retaining its bytes. */
export async function validateArtifactSource(
  source: unknown,
  policy: PreviewPolicy,
): Promise<{ ok: true; source: ArtifactSource } | { ok: false; code: PreviewFailureCode; message: string }> {
  if (!isSourceRecord(source)) return failure('source-invalid', 'artifact source must be a local path or HTTP(S) URL')
  if (source.kind === 'local') {
    if (containsParentSegment(source.path)) {
      return failure('source-path-not-allowed', 'local artifact path must not contain a parent segment')
    }
    if (!isAbsolutePath(source.path)) {
      return failure('source-path-not-allowed', 'local artifact path must be absolute')
    }
    const candidate = resolve(source.path)
    try {
      const candidateReal = await realpath(candidate)
      const roots = await Promise.all(policy.allowedRoots.map(root => realpath(resolve(root))))
      if (!roots.some(root => isContained(root, candidateReal))) {
        return failure('source-path-not-allowed', 'local artifact path is outside configured roots')
      }
      return { ok: true, source: Object.freeze({ kind: 'local', path: candidate, label: source.label }) }
    } catch (error) {
      return failure('source-unavailable', errorMessage(error))
    }
  }

  let parsed: URL
  try {
    parsed = new URL(source.url)
  } catch {
    return failure('source-invalid', 'artifact URL is invalid')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return failure('source-scheme-not-allowed', 'artifact URL must use HTTP or HTTPS')
  }
  if (!policy.allowedUrlOrigins.includes(parsed.origin)) {
    return failure('source-origin-not-allowed', 'artifact URL origin is not configured')
  }
  return { ok: true, source: Object.freeze({ kind: 'url', url: parsed.href, label: source.label }) }
}

/** Read and bound one validated source. Returned bytes are transient. */
export async function readArtifactPreview(
  source: ArtifactSource,
  policy: PreviewPolicy,
): Promise<{ ok: true; preview: ArtifactPreview } | { ok: false; code: PreviewFailureCode; message: string }> {
  const validated = await validateArtifactSource(source, policy)
  if (!validated.ok) return validated
  try {
    const text = validated.source.kind === 'local'
      ? await readLocal(validated.source)
      : await readRemote(validated.source)
    const truncated = text.length > policy.maxPreviewChars
    const bounded = text.slice(0, policy.maxPreviewChars)
    const html = isHtmlSource(validated.source)
    return html
      ? { ok: true, preview: Object.freeze({ kind: 'srcdoc', srcdoc: bounded, truncated }) }
      : { ok: true, preview: Object.freeze({ kind: 'text', text: escapeTextWithin(bounded, policy.maxPreviewChars), truncated }) }
  } catch (error) {
    return failure('preview-read-failed', errorMessage(error))
  }
}

/** Escape text before a browser renders it as text. */
export function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
}

/** Escape text while keeping the complete wire value within a character cap. */
function escapeTextWithin(value: string, maxChars: number): string {
  let output = ''
  for (const character of value) {
    const escaped = escapeText(character)
    if (output.length + escaped.length > maxChars) break
    output += escaped
  }
  return output
}

function isSourceRecord(value: unknown): value is LocalArtifactSource | UrlArtifactSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record.kind === 'local' && typeof record.path === 'string' && typeof record.label === 'string')
    || (record.kind === 'url' && typeof record.url === 'string' && typeof record.label === 'string')
}

function containsParentSegment(path: string): boolean {
  return path.split(/[\\/]/u).some(segment => segment === '..')
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\') || path.startsWith('/')
}

function isContained(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate)
  return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${candidateSeparator()}`) && !remainder.startsWith('../') && !remainder.startsWith('..\\') && !remainder.includes(`:${candidateSeparator()}`))
}

function candidateSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

function isHtmlSource(source: ArtifactSource): boolean {
  const name = source.kind === 'local' ? source.path : new URL(source.url).pathname
  const extension = extname(name).toLowerCase()
  return extension === '.html' || extension === '.htm' || extension === '.svg'
}

async function readLocal(source: LocalArtifactSource): Promise<string> {
  return readFile(source.path, 'utf8')
}

async function readRemote(source: UrlArtifactSource): Promise<string> {
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`preview request failed with HTTP ${String(response.status)}`)
  return response.text()
}

async function realpath(path: string): Promise<string> {
  const { realpath: resolveRealpath } = await import('node:fs/promises')
  return resolveRealpath(path)
}

function failure(code: PreviewFailureCode, message: string): { ok: false; code: PreviewFailureCode; message: string } {
  return { ok: false, code, message }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** UTF-8 byte length helper used by Host payload validation. */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}
