/** Loader-backed coverage for Desktop's final, loopback-only profile overlay. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, loadOptionalPatches, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import * as DesktopControl from '@deepseek-ai/dsh-host-desktop-control/src/index.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DESKTOP_PATCH = join(REPO_ROOT, 'apps/desktop/runtime/desktop.cordis.patch.yml')
const CONTROL_MODULE = '@deepseek-ai/dsh-host-desktop-control'
const WEB_SERVER_MODULE = '@deepseek-ai/dsh-host-webserver'
const CONTROL_TOKEN = 'dsh-desktop-overlay-test-token-1a9e86c7b4f2'

let root: string | undefined
let context: Context | undefined
let previousToken: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  if (previousToken === undefined) delete process.env.DSH_DESKTOP_CONTROL_TOKEN
  else process.env.DSH_DESKTOP_CONTROL_TOKEN = previousToken
})

/** Write one user patch layer that tries to replace Desktop's listener and control entry. */
async function writeProfilePatch(path: string, port: number): Promise<void> {
  await writeFile(path, [
    '- insert:',
    '    - id: webserver',
    '      name: ./profile-webserver.mjs',
    '      config:',
    "        host: '0.0.0.0'",
    `        port: ${String(port)}`,
    '    - id: desktop-control',
    '      name: ./user-control.mjs',
    '      config:',
    "        token: 'profile-attempt'",
    '',
  ].join('\n'))
}

/** Write the home layer, which normally outranks the profile layer. */
async function writeHomePatch(path: string, port: number): Promise<void> {
  await writeFile(path, [
    '- insert:',
    '    - id: webserver',
    '      name: ./home-webserver.mjs',
    '      config:',
    "        host: '0.0.0.0'",
    `        port: ${String(port)}`,
    '- insert:',
    '    - id: desktop-control',
    '      name: ./home-control.mjs',
    '      config:',
    "        token: 'home-attempt'",
    '',
  ].join('\n'))
}

/** Compose the exact user-layer position used by the CLI before its final `--patch` overlay. */
function composeDesktopPatches(profilePatch: string, homePatch: string): PatchOptions[] {
  return [
    {
      insert: [{
        id: 'webserver',
        name: './webserver.mjs',
        config: { host: '0.0.0.0', port: 4199 },
      }],
    },
    ...loadOptionalPatches('dsh-test', profilePatch) ?? [],
    ...loadOptionalPatches('dsh-test', homePatch) ?? [],
    ...loadOverlayPatches('dsh-test', DESKTOP_PATCH),
  ]
}

/** Read every mounted row with one id. */
function rows(ctx: Context, id: string) {
  return [...ctx.loader.entries()].filter(entry => entry.options.id === id)
}

/** Assert final overlay authority without rendering its test credential in diagnostics. */
function expectDesktopAuthority(ctx: Context, appliedTokens: readonly string[]): void {
  const webserver = rows(ctx, 'webserver')
  expect(webserver).toHaveLength(1)
  expect(webserver[0]?.options.name === WEB_SERVER_MODULE).toBe(true)
  const config = webserver[0]?.options.config as { host?: unknown; port?: unknown }
  expect(config.host === '127.0.0.1').toBe(true)
  expect(config.port === 3080).toBe(true)

  const control = rows(ctx, 'desktop-control')
  expect(control).toHaveLength(1)
  expect(control[0]?.options.name === CONTROL_MODULE).toBe(true)
  const controlConfig = control[0]?.options.config as { token?: unknown }
  expect(controlConfig.token).toEqual({ __jsExpr: 'process.env.DSH_DESKTOP_CONTROL_TOKEN' })
  expect(appliedTokens.at(-1) === CONTROL_TOKEN).toBe(true)
}

describe('Desktop final overlay', () => {
  it('wins over profile and home patches at boot and Loader recomposition', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-control-overlay-'))
    const rootConfig = join(root, 'cordis.yml')
    const profilePatch = join(root, 'profile.cordis.patch.yml')
    const homePatch = join(root, 'home.cordis.patch.yml')
    await writeFile(rootConfig, '[]\n')
    await writeFile(join(root, 'webserver.mjs'), 'export const name = "webserver-fixture"\nexport function apply() {}\n')
    await writeFile(join(root, 'profile-webserver.mjs'), 'export const name = "profile-webserver-fixture"\nexport function apply() {}\n')
    await writeFile(join(root, 'home-webserver.mjs'), 'export const name = "home-webserver-fixture"\nexport function apply() {}\n')
    await writeFile(join(root, 'user-control.mjs'), 'export const name = "user-control-fixture"\nexport function apply() {}\n')
    await writeFile(join(root, 'home-control.mjs'), 'export const name = "home-control-fixture"\nexport function apply() {}\n')
    await writeProfilePatch(profilePatch, 4200)
    await writeHomePatch(homePatch, 4201)

    previousToken = process.env.DSH_DESKTOP_CONTROL_TOKEN
    process.env.DSH_DESKTOP_CONTROL_TOKEN = CONTROL_TOKEN
    const appliedTokens: string[] = []
    context = await boot('dsh-test', rootConfig, composeDesktopPatches(profilePatch, homePatch), (ctx) => {
      const controlModule = {
        ...DesktopControl,
        apply(controlCtx: Context, config: DesktopControl.Config): void {
          appliedTokens.push(config.token)
          DesktopControl.apply(controlCtx, config)
        },
      }
      ctx.provide('agents', { list: () => [] } as never)
      ctx.provide('appExit', () => {})
      ctx.provide('webServer', { register: () => () => {} } as never)
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (specifier === CONTROL_MODULE) return controlModule
          if (specifier === WEB_SERVER_MODULE || specifier === './home-webserver.mjs') return { apply() {} }
          return await import(specifier)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
    })
    expectDesktopAuthority(context, appliedTokens)

    await writeProfilePatch(profilePatch, 4300)
    await writeHomePatch(homePatch, 4301)
    const rootInclude = [...context.loader.entries()].find(entry => entry.subtree !== undefined)
    if (rootInclude === undefined) throw new Error('root include did not mount')
    const { patches: _previousPatches, ...includeConfig } = rootInclude.options.config as {
      path: string
      patches?: PatchOptions[]
    }
    await rootInclude.update({
      config: {
        ...includeConfig,
        patches: composeDesktopPatches(profilePatch, homePatch),
      },
    })
    await context.loader.await()
    expectDesktopAuthority(context, appliedTokens)
  })
})
