/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-desktop-control`.
 * @module @deepseek-ai/dsh-host-desktop-control/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-desktop-control'

/** Cordis companion plugin name. */
export const name = 'host-desktop-control-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the web server owns registered-route lifecycle, and
 * this plugin retains no local authoritative state beyond effect-scoped registrations.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
