# Artifact Sidebar Resilience Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task.

**Goal:** Promote Artifact Sidebar to a first-party web plugin whose selected artifact, draft, pins, and queued feedback survive DSH restart, browser reload, reconnect, and a crash without duplicate agent feedback.

**Architecture:** A static Host package owns validation, preview reads, append-only session events, a client-visible session projection, and durable outbox recovery. A static Client package contributes one `shell.overlay` entry and renders only confirmed projection state. The web bundle composes both halves and API Remotes exposes the Host namespace. The session log, not a dynamic registry or browser storage, is the durable authority.

**Tech Stack:** TypeScript strict ESM, Cordis, Typert Remote, session projection/cache, React 18, CSS modules, Zod, Vitest, existing Web bundle and Chrome-only E2E.

**Spec:** `docs/superpowers/specs/2026-08-24-artifact-sidebar-resilience-design.md`

**Global constraints:** Keep dynamic Cordis packages process-scoped; do not add generic dynamic-package persistence. All Artifact Sidebar state-changing events are whole bounded snapshots and `ignorable: true`. The feedback delivery message is a `user/message`; its `artifact-sidebar` source carries the durable `submissionId`, so recovery can find it exactly. Local paths must resolve below configured real roots and reject symlink escapes. Never clear a client draft or pin before the matching durable projection arrives. Run only focused checks until the final verification task. Do not touch unrelated dirty files.

### Task 1: Define Artifact Sidebar durable vocabulary and projection

**Files:**
- Create: `packages/extensions/artifact-sidebar/src/types.ts`
- Create: `packages/extensions/artifact-sidebar/src/domain.ts`
- Create: `packages/extensions/artifact-sidebar/src/fold.ts`
- Create: `packages/extensions/artifact-sidebar/tests/fold.spec.ts`

**Step 1: Write failing projection tests.** Cover empty state, source/draft/pin whole-value replacement, stable ordered pin ids, queued submission removed only by its matching durable message, and unknown/non-Artifact events returning the identical state reference.

```ts
session.append('artifact-sidebar/state', { state: withPin('pin-1') }, { ignorable: true })
session.append('artifact-sidebar/submission-queued', { submission }, { ignorable: true })
session.append('user/message', queuedMessage(submission))
expect(foldArtifactSidebar(session.events)).toEqual({ ...withPin('pin-1'), pending: [] })
```

**Step 2: Run focused red test.**

Run: `pnpm vitest run packages/extensions/artifact-sidebar/tests/fold.spec.ts`

Expected: FAIL because the package and fold do not exist.

**Step 3: Implement pure vocabulary and fold.** Define branded `ArtifactPinId` and `ArtifactSubmissionId`; `ArtifactSource`, `ArtifactPin`, `ArtifactSidebarState`, and `ArtifactSubmission`. In `domain.ts`, merge `MessageSourceMap` with `{ kind: 'artifact-sidebar', submissionId }` and `SessionEventMap` with `artifact-sidebar/state` and `artifact-sidebar/submission-queued`. Both artifacts carry complete post-change values and are `ignorable: true` at append time. `fold.ts` validates and folds only these events plus matching `user/message` sources; freeze/copy returned snapshots.

**Step 4: Run focused green test.**

Run: `pnpm vitest run packages/extensions/artifact-sidebar/tests/fold.spec.ts`

Expected: PASS.

**Step 5: Commit.**

```bash
git add packages/extensions/artifact-sidebar/src packages/extensions/artifact-sidebar/tests/fold.spec.ts
git commit -m "feat: define artifact sidebar session state"
```

### Task 2: Implement Host package, validation, projection, and preview reads

**Files:**
- Create: `packages/extensions/artifact-sidebar/package.json`
- Create: `packages/extensions/artifact-sidebar/tsconfig.json`
- Create: `packages/extensions/artifact-sidebar/tsdown.config.ts`
- Create: `packages/extensions/artifact-sidebar/src/index.ts`
- Create: `packages/extensions/artifact-sidebar/src/invariant.ts`
- Create: `packages/extensions/artifact-sidebar/src/preview.ts`
- Create: `packages/extensions/artifact-sidebar/src/css-modules.d.ts` only if generated client typing needs it; otherwise omit
- Create: `packages/extensions/artifact-sidebar/README.md`
- Create: `packages/extensions/artifact-sidebar/tests/service.spec.ts`
- Create: `packages/extensions/artifact-sidebar/tests/preview.spec.ts`

**Step 1: Write failing Host tests.** Use a live-agent fixture and assert that each accepted state replacement appends one bounded whole event, installs `artifactSidebar` projection, rejects blank/oversize notes and more than `maxPins`, and retains state when a request fails. Add table tests for allowed local path, `..` escape, symlink escape, unsupported scheme/origin, and preview-size cap.

```ts
await expect(service.setState(agent, { ...state, pins: tooManyPins }))
  .resolves.toEqual({ ok: false, error: { code: 'too-many-pins', maxPins: 8 } })
expect(agent.session.events).toHaveLength(0)
```

**Step 2: Run focused red tests.**

Run: `pnpm vitest run packages/extensions/artifact-sidebar/tests/service.spec.ts packages/extensions/artifact-sidebar/tests/preview.spec.ts`

Expected: FAIL because service, config and preview reader do not exist.

**Step 3: Implement Host behavior.** Build `ArtifactSidebarService extends TypertRemoteService` with explicit config: `allowedRoots`, `allowedUrlOrigins`, `maxPreviewChars`, `maxPins`, `maxSourceLabelBytes`, `maxPinNoteBytes`, `maxDraftBytes`, and `maxSubmissionBytes`. Use a real-path containment check after resolving each local source and reject symlinks that escape a root. Allow only configured HTTPS/HTTP origins. Read local HTML/SVG as `srcdoc`, text as escaped text, and bound preview text without persisting bytes. Register a `sessionProjections` unit named `artifactSidebar`; `stateVersion: 1`; its wire view is the durable state plus queued submissions.

**Step 4: Add independent invariant and package metadata.** The companion checks every `artifact-sidebar/*` payload is decodable, bounded, and internally consistent; it does not infer correctness from service presence. Export `.`, `./types`, `./invariant`, `./typert`, `./remote`, `./src/*`, and `./package.json`; add all required project references and a README with Config, Model Experience, KV-cache effect, and limitations.

**Step 5: Run focused green tests.**

Run: `pnpm vitest run packages/extensions/artifact-sidebar/tests/service.spec.ts packages/extensions/artifact-sidebar/tests/preview.spec.ts && pnpm exec tsc -b packages/extensions/artifact-sidebar`

Expected: PASS.

**Step 6: Commit.**

```bash
git add packages/extensions/artifact-sidebar
git commit -m "feat: add durable artifact sidebar host"
```

### Task 3: Make submission delivery crash-safe and exactly once

**Files:**
- Modify: `packages/extensions/artifact-sidebar/src/index.ts`
- Modify: `packages/extensions/artifact-sidebar/src/fold.ts`
- Modify: `packages/extensions/artifact-sidebar/tests/service.spec.ts`
- Create: `packages/extensions/artifact-sidebar/tests/recovery.spec.ts`

**Step 1: Write failing recovery tests.** Simulate (a) crash after durable queue before steer, (b) crash after steer before RPC acknowledgement, (c) retry of the same id, and (d) a cold session whose persisted user message already exists. Assert exactly one matching `user/message` and no loss of pins/draft until its delivery is observed.

```ts
await service.submit(agent, { submissionId, state })
await restartWithPersistedLog(agent.session)
expect(messagesFor(submissionId)).toHaveLength(1)
expect(await service.submit(agent, { submissionId, state })).toMatchObject({ ok: true, delivered: true })
```

**Step 2: Run focused red test.**

Run: `pnpm vitest run packages/extensions/artifact-sidebar/tests/recovery.spec.ts`

Expected: FAIL because no durable outbox/recovery driver exists.

**Step 3: Implement queued-outbox protocol.** On `submit`, validate and format feedback; build one frozen `createUserMessage` with `source: { kind: 'artifact-sidebar', submissionId }`; append `artifact-sidebar/submission-queued` containing the complete submission and message payload; call `ctx.sessions.flush(agent.session)`; then `agent.steer(message)`. Serialize admissions per exact live agent. On `agent/session-start`, scan the recovered log: for every queued id without a `user/message` carrying that id, steer the stored immutable message once; a matching message is delivery proof and no second send occurs. A throw or disconnected RPC leaves the queue state retryable.

**Step 4: Run focused green test.**

Run: `pnpm vitest run packages/extensions/artifact-sidebar/tests/recovery.spec.ts packages/extensions/artifact-sidebar/tests/fold.spec.ts`

Expected: PASS.

**Step 5: Commit.**

```bash
git add packages/extensions/artifact-sidebar/src packages/extensions/artifact-sidebar/tests
git commit -m "feat: recover artifact sidebar submissions"
```

### Task 4: Expose the static Host Remote in the API assembly

**Files:**
- Modify: `packages/api/remotes/src/client/index.ts`
- Modify: `packages/api/remotes/package.json`
- Modify: `packages/api/remotes/tsconfig.client.json`
- Modify: `packages/api/remotes/tsconfig.host.json`
- Modify: `packages/api/remotes/tests/built-lib.e2e.ts`
- Modify: `tsconfig.host.json`

**Step 1: Write failing API assembly test.** Add a static Artifact Sidebar fixture to the built-library Remote test and prove its `state`, `setState`, `readPreview`, and `submit` descriptors mount under `ctx.remote.artifactSidebar`.

**Step 2: Run focused red test.**

Run: `pnpm vitest run packages/api/remotes/tests/built-lib.e2e.ts -t "artifact sidebar"`

Expected: FAIL because the Remote contribution is absent.

**Step 3: Mount and type the contribution.** Import `artifactSidebarRemote`, include it once in the mount roster and type-only remote outlet, then add Host/Client compilation references and workspace dependencies. Add the Host package to the host aggregate only; add it to the Client aggregate indirectly through API Remotes, not through its Host runtime.

**Step 4: Run focused green test.**

Run: `pnpm vitest run packages/api/remotes/tests/built-lib.e2e.ts -t "artifact sidebar" && pnpm exec tsc -b packages/api/remotes/tsconfig.host.json packages/api/remotes/tsconfig.client.json`

Expected: PASS.

**Step 5: Commit.**

```bash
git add packages/api/remotes tsconfig.host.json
git commit -m "feat: expose artifact sidebar remote"
```

### Task 5: Build the static browser plugin and resilient overlay

**Files:**
- Create: `packages/client/ui-artifact-sidebar/package.json`
- Create: `packages/client/ui-artifact-sidebar/tsconfig.json`
- Create: `packages/client/ui-artifact-sidebar/tsdown.config.ts`
- Create: `packages/client/ui-artifact-sidebar/src/index.ts`
- Create: `packages/client/ui-artifact-sidebar/src/invariant.ts`
- Create: `packages/client/ui-artifact-sidebar/src/client/ArtifactSidebar.tsx`
- Create: `packages/client/ui-artifact-sidebar/src/client/ArtifactSidebar.module.css`
- Create: `packages/client/ui-artifact-sidebar/src/client/controller.ts`
- Create: `packages/client/ui-artifact-sidebar/src/client/slots.ts`
- Create: `packages/client/ui-artifact-sidebar/src/client/locales.ts`
- Create: `packages/client/ui-artifact-sidebar/src/css-modules.d.ts`
- Create: `packages/client/ui-artifact-sidebar/tests/browser-plugin.client.spec.tsx`
- Create: `packages/client/ui-artifact-sidebar/tests/controller.client.spec.ts`
- Create: `packages/client/ui-artifact-sidebar/tests/sidebar.client.spec.tsx`
- Create: `packages/client/ui-artifact-sidebar/README.md`

**Step 1: Write failing Client tests.** Assert exactly one `shell.overlay` entry `{ id: 'artifact-sidebar', order: 90 }`, registration disappears on fiber dispose, launcher/panel render from `useProjection('artifactSidebar')`, and a `connection/reset` refreshes preview/error state without discarding confirmed projection state. Test annotation click coordinates, marker removal, disabled send until a pin or note exists, and retry after a transport failure.

```tsx
expect(entry()).toMatchObject({ id: 'artifact-sidebar', order: 90 })
await fiber.dispose()
expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
```

**Step 2: Run focused red tests.**

Run: `pnpm vitest run packages/client/ui-artifact-sidebar/tests`

Expected: FAIL because the Client package does not exist.

**Step 3: Implement the browser half.** Follow the `ui-goal` projection pattern: use the selected session's `useProjection('artifactSidebar')` as source of truth, and use an object-layer controller only for preview loading/operation status. Register `shell.overlay` through `ctx.slots.inject`; localize all copy. Preserve existing UX: right-edge launcher, fixed right panel, session tail in header, reload button, sandboxed URL iframe or `srcdoc`/escaped text preview, annotation overlay, numbered `%` pins, per-pin note, general note, and send action. Generate a UUID once per click and retain it through a retry. Never use `window`/`document` directly outside React or static CSS.

**Step 4: Make reload/reconnect resilient.** A source/draft/pin edit calls the Host then waits for the echoed projection; do not clear local input optimistically. If preview is unavailable after restart, show a recoverable error and the preserved annotation state. On `connection/reset`, recreate only temporary preview state; projection hydration restores the workspace.

**Step 5: Add metadata and invariant.** Declare client injection for runtime, API Remotes, locale, layout slot types, and the client-safe Artifact Sidebar type outlet. Use standard client exports, bundle entry, references, README Model Experience, and an invariant companion that explains why the one registration/controller fiber has no independent runtime relationship to assert.

**Step 6: Run focused green tests.**

Run: `pnpm vitest run packages/client/ui-artifact-sidebar/tests && pnpm exec tsc -b packages/client/ui-artifact-sidebar`

Expected: PASS.

**Step 7: Commit.**

```bash
git add packages/client/ui-artifact-sidebar tsconfig.client.json
git commit -m "feat: add resilient artifact sidebar ui"
```

### Task 6: Compose the permanent web profile and replace the dynamic instance

**Files:**
- Modify: `packages/bundle/web-app/cordis.patch.yml`
- Modify: `packages/bundle/web-app/package.json`
- Modify: `tsconfig.client.json`
- Modify: `tsconfig.host.json`
- Modify: `pnpm-lock.yaml` only if the workspace importer changes it
- Create: `packages/bundle/web-app/tests/artifact-sidebar-composition.spec.ts`

**Step 1: Write failing composition test.** Boot the unbuilt web profile fixture and assert it loads both named static plugins without `cordis-client-runner` dynamic definition/run state, with exactly one overlay id.

**Step 2: Run focused red test.**

Run: `pnpm vitest run packages/bundle/web-app/tests/artifact-sidebar-composition.spec.ts`

Expected: FAIL because no static roster rows/dependencies exist.

**Step 3: Compose the two static rows.** Add a Host `artifact-sidebar` row beside other durable session-side services with explicit conservative config; add browser `ui-artifact-sidebar` after layout/conversation prerequisites. Add both workspace dependencies and compilation aggregate references. Rebuild lockfile only through `pnpm install --lockfile-only` if required. Before enabling the static profile in the live runtime, remove the one-off dynamic Artifact Sidebar definition through its own DSH controls; never touch any other Chrome tab.

**Step 4: Run focused green tests.**

Run: `pnpm vitest run packages/bundle/web-app/tests/artifact-sidebar-composition.spec.ts && pnpm exec tsc -b packages/bundle/web-app`

Expected: PASS.

**Step 5: Commit.**

```bash
git add packages/bundle/web-app/cordis.patch.yml packages/bundle/web-app/package.json packages/bundle/web-app/tests/artifact-sidebar-composition.spec.ts tsconfig.client.json tsconfig.host.json
# Add pnpm-lock.yaml here only if pnpm changed it.
git commit -m "feat: compose permanent artifact sidebar"
```

### Task 7: Add assembled transcript and restart coverage

**Files:**
- Create: `apps/web/tests/artifact-sidebar.e2e.ts`
- Create: `apps/web/tests/artifact-sidebar.snapshot.ts`
- Modify: `tsconfig.host.json`
- Create: `.agents/notes/implemented/feature/2026-08-24-artifact-sidebar-resilience.md`
- Modify: relevant generated subsystem/package catalog only when its checked generator requires it

**Step 1: Write failing acceptance tests.** Use the real web scaffolding to persist source/draft/pins, stop and recreate the Host/session, reconnect the Client, and assert the projected workspace returns. Then submit one known UUID across an interrupted acknowledgement and assert the transcript contains one `[Artifact Sidebar]` feedback message. Snapshot the model-visible text and source attribution.

**Step 2: Run focused red tests.**

Run: `pnpm vitest run apps/web/tests/artifact-sidebar.e2e.ts apps/web/tests/artifact-sidebar.snapshot.ts`

Expected: FAIL until the static profile and recovery logic are complete.

**Step 3: Implement only missing integration seams.** Add fixture support for the projection and build the Agent Note with the final event grammar, durability barrier, exactly-once proof, source-validation policy, recovery behavior, and why dynamic persistence remains excluded. Update affected README/JSDoc/catalog output together.

**Step 4: Run focused green tests.**

Run: `pnpm vitest run apps/web/tests/artifact-sidebar.e2e.ts apps/web/tests/artifact-sidebar.snapshot.ts`

Expected: PASS.

**Step 5: Commit.**

```bash
git add apps/web/tests/artifact-sidebar.e2e.ts apps/web/tests/artifact-sidebar.snapshot.ts tsconfig.host.json .agents/notes/implemented/feature/2026-08-24-artifact-sidebar-resilience.md
# Add only the exact catalog/README files changed by its generator.
git commit -m "test: cover artifact sidebar recovery"
```

### Task 8: Verify build artifacts and Chrome behavior on the dedicated tab

**Files:**
- Verify only; no planned source changes.

**Step 1: Build changed packages and static web bundle.**

Run: `pnpm exec tsdown --config packages/extensions/artifact-sidebar/tsdown.config.ts && pnpm exec tsdown --config packages/client/ui-artifact-sidebar/tsdown.config.ts && pnpm exec tsdown --config packages/bundle/web-app/tsdown.config.ts`

Expected: PASS; generated client module is present without a dynamic-run card.

**Step 2: Run proportionate repository checks.**

Run: `pnpm exec tsc -b packages/extensions/artifact-sidebar packages/api/remotes/tsconfig.host.json packages/api/remotes/tsconfig.client.json packages/client/ui-artifact-sidebar packages/bundle/web-app && pnpm vitest run packages/extensions/artifact-sidebar/tests packages/client/ui-artifact-sidebar/tests packages/api/remotes/tests/built-lib.e2e.ts packages/bundle/web-app/tests/artifact-sidebar-composition.spec.ts apps/web/tests/artifact-sidebar.e2e.ts apps/web/tests/artifact-sidebar.snapshot.ts`

Expected: PASS. If a command is sandbox-blocked, rerun unchanged with the narrowest host escalation; diagnose only genuine failures.

**Step 3: Chrome E2E, dedicated Artifact Sidebar tab only.** Confirm static launcher and panel after browser reload; choose a local test artifact; add a pin and draft; restart only the approved DSH runtime; reload that same tab; prove source/draft/pin recovery. Before pressing **Invia all'agente**, request action-time confirmation because it appends a model-visible session message. After approval, submit once, retry the same UUID through a simulated response interruption, and verify one chat entry and cleared delivered outbox.

**Step 4: Report evidence and remaining limitations.** Record commands run, final static plugin status, persistence/recovery outcome, and known framing restrictions. Keep monitoring scoped to the dedicated Artifact Sidebar tab; do not enumerate, claim, or manipulate any other Chrome tab.
