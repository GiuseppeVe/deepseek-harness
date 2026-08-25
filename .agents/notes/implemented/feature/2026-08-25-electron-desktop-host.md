# Agent Note: Electron desktop host authority

Status: implemented

English | [中文](2026-08-25-electron-desktop-host.zh.md)

## Problem

Desktop host exposes a local HTTP listener to its renderer. Profile and home patches can add duplicate entry ids, replace plugin names, or select a non-loopback listener. Those user-controlled rows cannot choose Desktop's listener or its process-control route.

## Decision

The final Desktop patch root-`upsert`s `webserver` and `desktop-control` after every profile and home layer. It retains one canonical `@deepseek-ai/dsh-host-webserver` row at `127.0.0.1:3080` and one canonical `@deepseek-ai/dsh-host-desktop-control` row whose token resolves from `DSH_DESKTOP_CONTROL_TOKEN`.

Include owns root `upsert` as shared composition behavior. Each explicit nonempty id replaces every matching root row at the first matching position or appends when absent; the rebuilt id index applies later patches to canonical rows. `upsert` rejects a nested target, duplicate or empty ids, and every sibling entry operation before Include reconciles its child tree.

`dsh-host-desktop-control` registers authenticated method-specific status, identity, and shutdown routes through effect-scoped web-server registrations. Status remains exactly `{ activity: 'idle' | 'active' }`. Identity returns only the process PID and an apply-lifetime cryptographic nonce; shutdown response finish occurs before it calls the launcher exit callback, and callback errors are contained.

`apps/desktop` owns one Electron-as-Node DSH child. It places DSH home, `.env`, sessions, settings, bounded logs, and its PID/nonce/creation-FILETIME/token lease below `%LOCALAPPDATA%\DSH Desktop`; startup rejects reparse points and resets the root plus every existing descendant DACL to the current SID before descendant writes. The production fixed encoded noninteractive PowerShell program receives the root only through process environment.

Only an explicit loopback TCP connection refusal permits spawn. Any occupied listener must prove readiness, lease, authenticated PID/nonce identity, and current creation FILETIME before reattach; every mismatch is a conflict. A fresh child must authenticate its spawned PID before lease write. Every force call revalidates the full identity, so direct spawn alone never permits post-reconnect termination. Reattached identities receive bounded monitoring.

The Electron main process holds the single-instance lock, builds and hardens one loopback-only window before backend startup, and queues early second-instance focus. Lifecycle transitions serialize. Native dialogs handle redacted startup and backend failure recovery; the renderer has no unavailable-event bridge. Preload exposes frozen status, restart, and close requests only from the Desktop-origin main frame. Every main-process handler checks the sole WebContents, its main frame, and exact loopback origin.

## Alternatives considered

- **Id-targeted webserver config override** — rejected; it preserves user-selected plugin names and duplicate root rows.
- **CLI-local duplicate filtering** — rejected; config dumps and live Include recomposition must share the same patch algorithm.
- **Exit before the shutdown response finishes** — rejected; process exit may cut off the acknowledged response.

## Consequences

Desktop profiles cannot select another listener, port, control plugin, or control token. Other Include callers can use root `upsert` where a final layer must own one entry; malformed declarations fail loud instead of discarding sibling fields. Desktop control owns no local lifecycle state, and dispose removes all routes. Desktop accepts only a Windows local-user data root, one Electron window, and one DSH child; installer staging remains separate from this lifecycle owner.

## Verification

`packages/boot/app-boot/tests/config-dump.spec.ts` pins replacement, append, root-only, and invalid `upsert` behavior. `apps/cli/tests/desktop-control.e2e.ts` boots and live-recomposes conflicting profile and home webserver/control rows. `packages/host/desktop-control/tests/desktop-control.spec.ts` covers authentication, identity, shutdown ordering, invalid token config, and route disposal. `apps/desktop/tests` covers real Windows DACL reset, reparse-safe invocation, complete lease validation, TCP occupancy, exact identity/FILETIME reattach and termination gates, reattach monitoring, serialized lifecycle, main-frame/origin IPC, preload gating, early focus, native recovery, window hardening, and close choices.
