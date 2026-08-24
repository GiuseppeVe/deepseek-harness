# Agent Note: Electron desktop host authority

Status: implemented

English | [中文](2026-08-25-electron-desktop-host.zh.md)

## Problem

Desktop host exposes a local HTTP listener to its renderer. Profile and home patches can add duplicate entry ids, replace plugin names, or select a non-loopback listener. Those user-controlled rows cannot choose Desktop's listener or its process-control route.

## Decision

The final Desktop patch root-`upsert`s `webserver` and `desktop-control` after every profile and home layer. It retains one canonical `@deepseek-ai/dsh-host-webserver` row at `127.0.0.1:3080` and one canonical `@deepseek-ai/dsh-host-desktop-control` row whose token resolves from `DSH_DESKTOP_CONTROL_TOKEN`.

Include owns root `upsert` as shared composition behavior. Each explicit nonempty id replaces every matching root row at the first matching position or appends when absent; the rebuilt id index applies later patches to canonical rows. `upsert` rejects a nested target, duplicate or empty ids, and every sibling entry operation before Include reconciles its child tree.

`dsh-host-desktop-control` registers authenticated method-specific status and shutdown routes through effect-scoped web-server registrations. Shutdown finishes its `202` response before containing the launcher exit callback.

## Alternatives considered

- **Id-targeted webserver config override** — rejected; it preserves user-selected plugin names and duplicate root rows.
- **CLI-local duplicate filtering** — rejected; config dumps and live Include recomposition must share the same patch algorithm.
- **Exit before the shutdown response finishes** — rejected; process exit may cut off the acknowledged response.

## Consequences

Desktop profiles cannot select another listener, port, control plugin, or control token. Other Include callers can use root `upsert` where a final layer must own one entry; malformed declarations fail loud instead of discarding sibling fields. Desktop control owns no local lifecycle state, and dispose removes both routes.

## Verification

`packages/boot/app-boot/tests/config-dump.spec.ts` pins replacement, append, root-only, and invalid `upsert` behavior. `apps/cli/tests/desktop-control.e2e.ts` boots and live-recomposes conflicting profile and home webserver/control rows. `packages/host/desktop-control/tests/desktop-control.spec.ts` covers authentication, shutdown ordering, invalid token config, and route disposal.
