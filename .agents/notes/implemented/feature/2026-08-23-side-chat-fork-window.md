# Agent Note: Side chat — `/side` forks an ephemeral restricted companion session with a fixed right-hand window

Status: implemented

## Problem

A long main conversation has no side lane: an exploratory question mutates the transcript, and a full subagent delegation is heavier than a quick parallel ask. The harness had no Codex-style side chat.

## Decision

The `/side` command (`dsh-command-side-chat`) creates an ordinary child session through `agentLoop.createAgent`, seeded from the parent's events minus the last `command/run`, tagged `origin: 'subagent'` plus `parentSession` but never registered in the subagent catalog — it stays out of `subagent.list`, is not continuable, and `session.prompt` serves it without `agent-busy`. Its tools restrict to `read/grep/glob` through `tools.restrict` inside try/catch, so a composition without the restriction service still boots. Session ids carry a millisecond timestamp (`side-<parent>-<n>-<ms>`), so JSONL persistence never collides across restarts, and each `/side` disposes the previous fork.

The window (`dsh-client-ui-side-chat`) occupies the `shell.overlay` list slot via `slots.inject` plus `slots.register`, polls `session.list`/`history`/`prompt` on a 700 ms interval, and injects its CSS inline. Two loader contracts shape both halves:

- The source-launch Loader resolves profile entries through tsx, which applies tsconfig `paths`: mapping a client package's bare specifier to `src/client` executes the browser half on the host at boot. Client packages map to their root `src` — the empty node half — and only the `/client` subpath names the browser face.
- A bare `ctx.<service>` property access throws outside a declared `inject`, in the browser too. The window declares no `inject`; every dependency is an optional `ctx.get()` read inside a retry budget, so the worst case is a missing window, never a blocked boot.

Given up: the fork stays invisible to the subagent lineage and dies with its parent; moving creation under the continuation manager would buy `subagent.prompt`/`interrupt` at the cost of catalog membership (`docs/side-chat.md`, "Estendere").

Verification: on the live web surface the plugin inventory lists both rows active, the boot roster carries the client entry, `/plugins/@deepseek-ai/dsh-client-ui-side-chat/client.js` serves 200, and fork sessions persist under `$DSH_HOME/sessions/<workspace>/side-*`.
