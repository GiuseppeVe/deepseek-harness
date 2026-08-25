/**
 * Composed-profile coverage for the final Desktop overlay. It exercises the
 * same patch parser and application order as `dsh --patch`, without binding
 * the fixed production port in the e2e runner.
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DESKTOP_PATCH = join(REPO_ROOT, 'apps/desktop/runtime/desktop.cordis.patch.yml')

function row(rows: readonly EntryOptions[], id: string): EntryOptions {
  const result = rows.find(entry => entry.id === id)
  if (result === undefined) throw new Error(`missing composed row ${id}`)
  return result
}

describe('Desktop final overlay', () => {
  it('keeps webserver loopback configuration above profile and home user layers', () => {
    const base: PatchOptions[] = [{ insert: [{
      id: 'webserver',
      name: '@deepseek-ai/dsh-host-webserver',
      config: { host: '0.0.0.0', port: 4199 },
    }] }]
    const profileUser: PatchOptions[] = [{
      id: 'webserver',
      config: { host: '0.0.0.0', port: 4200 },
    }]
    const homeUser: PatchOptions[] = [{
      id: 'webserver',
      config: { host: '0.0.0.0', port: 4201 },
    }]

    const entries = composeEntries([
      base,
      profileUser,
      homeUser,
      loadOverlayPatches('dsh-test', DESKTOP_PATCH),
    ])
    expect(row(entries, 'webserver').config).toEqual({ host: '127.0.0.1', port: 3080 })
    expect(row(entries, 'desktop-control')).toMatchObject({
      name: '@deepseek-ai/dsh-host-desktop-control',
    })
  })
})
