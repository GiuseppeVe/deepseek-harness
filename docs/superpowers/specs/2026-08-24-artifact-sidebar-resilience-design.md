# Artifact Sidebar Resilience Design

## Goal

Ship Artifact Sidebar as a first-party web plugin that remains available after a DSH process restart, browser reload, or reconnect, and that restores a session's unsent annotation workspace without duplicate agent feedback.

## Scope

Artifact Sidebar becomes static Host and Client code composed by the web profile. The session log owns the selected artifact reference, draft text, annotation pins, and pending submissions. A restart may interrupt an operation, but it must not remove that state or create a duplicate feedback message.

The change does not persist arbitrary dynamic Cordis packages, their code, or their grants. Those packages remain process-scoped and keep their existing trust model.

## Plugin topology

`@deepseek-ai/dsh-artifact-sidebar` is a Host plugin under `packages/extensions/`. It owns artifact-source validation, preview reads, durable annotation state, and feedback submission recovery.

`@deepseek-ai/dsh-client-ui-artifact-sidebar` is a Client plugin under `packages/client/`. It registers one additive `shell.overlay` slot containing the launcher and side panel. Its unique slot key prevents duplicate registration. The Client reads the session projection rather than React or module state, so a page reload and `connection/reset` reconstruct the same workspace.

`packages/bundle/web-app/cordis.patch.yml` mounts both plugins in the normal web composition. Profile boot loads the static Client module on every page; no Cordis Run card, dynamic-package approval, or later dispatch is required. The one-off dynamic Artifact Sidebar is removed before enabling the static package so a live page cannot render two overlays.

## Durable session state

The Host extends `SessionEventMap` with ignorable `artifact-sidebar/*` events. The event projection is keyed by the owning session identity and contains:

- the selected source: a permitted local workspace path or permitted HTTP(S) URL;
- draft note text;
- ordered pins, including stable pin identifiers, coordinates, and note text;
- pending and delivered submission identifiers.

Each user edit appends a bounded event and the projection reconstructs a snapshot from the log. The event payload does not contain preview bytes. A local source stores its validated reference, not file contents. If that source is gone after recovery, the Client preserves annotations and displays a recoverable unavailable-source error.

The plugin config defines `allowedRoots`, allowed URL schemes and origins, `maxPreviewChars`, `maxPins`, and byte limits for source labels, pin notes, and draft text. Host validation applies these limits at the browser-to-Host RPC boundary, resolves local paths below an allowed real path, and rejects symlink escapes.

## Exactly-once feedback submission

The Client creates a UUID `submissionId` when the user submits pins. The Host first appends a durable `artifact-sidebar/submission-queued` event containing the bounded feedback payload, then steers one ordinary durable `user/message` whose source identifies `artifact-sidebar` and that `submissionId`.

On session startup, recovery compares queued identifiers with durable user messages. A queued identifier with no matching user message is steered again. A matching identifier is delivered and is never sent again. Retrying the same `submissionId` is idempotent. This covers crashes before the steer, after it, and before the Client receives the RPC response.

The model-visible feedback remains an ordinary `user/message`; it is therefore reconstructable from the session log. The `artifact-sidebar/*` events only preserve workspace and outbox state and may be ignored by runtimes that do not know them.

## Lifecycle and recovery

At Host boot, the session projection rebuilds from persisted events. At Client boot and on `connection/reset`, the static Client subscribes to the projection and renders it without a dynamic-runner handshake. A temporary RPC or transport failure leaves the latest confirmed projection visible, marks the operation retryable, and never clears a draft or pin optimistically until its durable event is acknowledged.

Runtime supervision remains responsible for restarting a failed web process. The plugin's recovery mechanism does not restart DSH, depend on in-memory registries, or replay arbitrary code.

## Verification

Automated coverage proves these acceptance cases:

- profile composition mounts the static Host and Client after a fresh web boot;
- source, draft, and pins survive a cold projection rebuild and browser reconnect;
- invalid paths, symlink escapes, disallowed URLs, and oversized payloads are rejected;
- an unavailable restored source preserves its annotation state and reports the error;
- submission retry with one `submissionId` emits one durable user message;
- simulated crashes before steering, after steering, and before RPC acknowledgement recover without loss or duplication;
- assembled web transcript and Chrome E2E cover add-pin, reload/restart, restore, and submit.

## Deferred work

Persisting generic dynamic Cordis definitions and approvals is a separate security and lifecycle design. It is not part of Artifact Sidebar promotion.
