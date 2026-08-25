# Tauri Desktop Host Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace session-created Electron desktop host with a Windows Tauri host that runs DSH without changing existing user plugins, presets, or settings.

**Architecture:** Tauri owns only an app-private backend process, app-private state, and a loopback WebView. It launches a managed DSH profile from a private `DSH_HOME`; it neither mounts patches into the user home nor operates on an existing listener. The upstream `hyperion2144/dsh-desktop-tauriapp` v0.6.4 is a behavior reference, not vendored code: its shared-home mutations, remote mode, mobile payload, desktop pet assets, and client injection are excluded.

**Tech Stack:** Tauri 2, Rust 2021, Tokio, static launch frontend, Node 22/pnpm, source DSH CLI.

**Spec:** `docs/superpowers/specs/2026-08-24-electron-desktop-host-design.md` (superseded for the host implementation by this plan; DSH ownership and safety requirements remain active).

## Global Constraints

- Never edit, remove, disable, move, or replace Auto, Side Chat, Artifact Sidebar, Voice, any other user plugin, or existing DSH settings.
- Never touch `examples/acp-agent/tests/snapshots/approval-auto/`.
- Tauri state, logs, profile, plugin payload, port lease, and runtime configuration live under its app-private data directory.
- The host may terminate only a child whose PID and authenticated readiness identity it created.
- Desktop chrome injection, remote targets, mobile features, profile migration, and pet assets are out of scope.
- Do not ship or test a SAC bypass. Signing is a later, separate change.
- Exclude upstream CC BY-NC-SA whale artwork and substitute repository-owned neutral assets.
- Pin any upstream factual reference to `hyperion2144/dsh-desktop-tauriapp` release `v0.6.4` commit `6c3ea8ae51efcaaf3fec50a5abb557d7d9246718`.

---

### Task 1: Remove only session-created Electron host

**Files:**
- Modify: all paths changed by commits `b57cca53eb..50be74ad6a`, excluding current dirty changes outside their changed-path set.
- Preserve: `apps/desktop/runtime/desktop.cordis.patch.yml` baseline from `c9489d916f` and all paths outside the exact commit range.
- Test: `git diff --check`; `git diff --name-only c9489d916f`.

**Interfaces:**
- Consumes: committed Electron host range and current dirty worktree.
- Produces: repository state with no Electron host source, Electron dependencies, Electron packaging configuration, or Electron-specific host-control changes.

- [ ] **Step 1: Record preservation manifest**

Run: `git diff --name-status c9489d916f..50be74ad6a`

Expected: Electron-owned paths are explicit; Auto, Side Chat, Artifact Sidebar, Voice, and `examples/acp-agent/tests/snapshots/approval-auto/` are absent.

- [ ] **Step 2: Revert only session-owned commits**

Apply reverse commits from `50be74ad6a` through `b57cca53eb`, resolving conflicts by preserving dirty paths outside the recorded manifest.

- [ ] **Step 3: Verify preservation**

Run: `git diff --check`

Expected: clean diff check; preserved plugin paths remain present and unchanged by this task.

### Task 2: Add isolated Tauri host skeleton

**Files:**
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/lib.rs`
- Create: `apps/desktop/src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src/index.html`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tests/private-state.spec.ts`

**Interfaces:**
- Consumes: an injected data-directory resolver and source DSH CLI path.
- Produces: `DesktopPaths` with `data_dir`, `dsh_home`, `logs_dir`, and `runtime_dir`; every result is descendant of the app-private data directory.

- [ ] **Step 1: Write failing private-state test**

```ts
it('keeps desktop DSH state outside the caller home', async () => {
  const paths = await resolveDesktopPaths({ appData: fixtureAppData, userHome: fixtureUserHome })
  expect(paths.dshHome.startsWith(fixtureAppData)).toBe(true)
  expect(paths.dshHome.startsWith(fixtureUserHome)).toBe(false)
})
```

- [ ] **Step 2: Run RED test**

Run: `pnpm --dir apps/desktop test -- private-state.spec.ts`

Expected: failure because `resolveDesktopPaths` does not exist.

- [ ] **Step 3: Implement minimal resolver and Tauri configuration**

Define `resolveDesktopPaths` in Rust with a narrow test-facing adapter. Configure a single loopback-only main window with explicit capability permissions; do not enable global Tauri APIs and do not load remote URLs.

- [ ] **Step 4: Run GREEN test**

Run: `pnpm --dir apps/desktop test -- private-state.spec.ts`

Expected: pass; test proves no user-home DSH path is selected.

### Task 3: Start and stop only host-owned DSH

**Files:**
- Create: `apps/desktop/src-tauri/src/backend.rs`
- Create: `apps/desktop/tests/backend-ownership.spec.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `DesktopPaths`, source CLI entry, loopback port request, child PID, readiness token.
- Produces: `OwnedBackend { pid, port, token }` only after authenticated `/__dsh/ready` success; `stop()` never signals an unowned process.

- [ ] **Step 1: Write failing ownership tests**

```ts
it('does not terminate a listener that this host did not spawn', async () => {
  const backend = await createBackend({ probe: occupiedByOtherProcess })
  await expect(backend.stop()).resolves.toEqual({ kind: 'unowned' })
  expect(occupiedByOtherProcess.terminated).toBe(false)
})
```

```ts
it('passes an app-private DSH_HOME to its child', async () => {
  const child = await startFixtureBackend()
  expect(child.environment.DSH_HOME).toBe(fixturePaths.dshHome)
})
```

- [ ] **Step 2: Run RED tests**

Run: `pnpm --dir apps/desktop test -- backend-ownership.spec.ts`

Expected: failures show absent ownership and private-home behavior.

- [ ] **Step 3: Implement minimal child lifecycle**

Spawn source DSH with an explicit private `DSH_HOME`, `127.0.0.1`, a free selected port, and a generated readiness token. Persist PID/token only in the private runtime directory. On shutdown, authenticate identity before graceful exit; return `unowned` without a signal when identity cannot be proved.

- [ ] **Step 4: Run GREEN tests**

Run: `pnpm --dir apps/desktop test -- backend-ownership.spec.ts`

Expected: both ownership tests pass.

### Task 4: Package, documentation, and review

**Files:**
- Create: `apps/desktop/README.md`
- Create: `apps/desktop/README.zh.md`
- Create: `apps/desktop/README.i18n.yaml`
- Create: `.agents/notes/implemented/feature/2026-08-25-tauri-desktop-host.md`
- Create: `.agents/notes/implemented/feature/2026-08-25-tauri-desktop-host.zh.md`
- Create: `.agents/notes/implemented/feature/2026-08-25-tauri-desktop-host.i18n.yaml`
- Modify: root workspace manifests only for reviewed Tauri dependencies and build commands.
- Test: package smoke, source unit tests, translation pairing, focused typecheck.

**Interfaces:**
- Consumes: host package and ownership tests.
- Produces: unsigned development package that documents SAC limitation and never claims signed distribution.

- [ ] **Step 1: Write failing package smoke assertion**

```ts
it('launches with a private DSH home and leaves an external DSH process alive', async () => {
  const result = await runPackagedSmoke()
  expect(result.externalProcessAlive).toBe(true)
  expect(result.privateHomeUsed).toBe(true)
})
```

- [ ] **Step 2: Run RED smoke**

Run: `pnpm --dir apps/desktop test -- package.e2e.ts`

Expected: failure before package launch wiring exists.

- [ ] **Step 3: Add package wiring and documentation**

Add Tauri build command, neutral licensed icons, a smoke harness, bilingual README/Agent Note, and translation-pair records. Document that unsigned Windows artifacts may be blocked by Smart App Control; no policy change is attempted.

- [ ] **Step 4: Run GREEN evidence**

Run: `pnpm --dir apps/desktop test`

Run: `pnpm --dir apps/desktop run build`

Run: `pnpm run verify-translation-pairing --write apps/desktop/README.i18n.yaml`

Run: `pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-25-tauri-desktop-host.i18n.yaml`

Expected: focused tests/build pass. If SAC blocks the unsigned executable, record the exact signed-package prerequisite; do not disable SAC.
