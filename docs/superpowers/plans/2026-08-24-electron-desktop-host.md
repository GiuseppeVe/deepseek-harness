# Electron Desktop Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Windows-only Electron application that owns a local DSH web backend and packages without Node.js or pnpm prerequisites.

**Architecture:** `apps/desktop` is Electron main/preload/renderer glue. Its main process starts the packaged `dsh web --host 127.0.0.1 --port 3080 --no-open` entry, waits for the web-app readiness route, owns shutdown, and loads the loopback UI. A small web-app readiness contribution makes server readiness observable without exposing a network endpoint outside loopback.

**Tech Stack:** Electron, electron-builder, TypeScript ESM, Node child processes, Vitest, existing DSH CLI/web bundle.

**Spec:** `docs/superpowers/specs/2026-08-24-electron-desktop-host-design.md`

## Global Constraints

- Windows only; bind backend only to `127.0.0.1:3080`.
- Package DSH runtime and production artifacts; require neither Node.js nor pnpm on target PC.
- Store `.env`, settings, sessions, and logs under `%LOCALAPPDATA%\\DSH Desktop`.
- Renderer uses `contextIsolation: true` and `nodeIntegration: false`.
- Electron owns and terminates only its DSH child process tree.
- No tray service, LAN listener, auto-update, or generic process killing.

---

### Task 1: Provide web-profile readiness

**Files:**
- Modify: `packages/bundle/web-app/src/startup.ts`
- Modify: `packages/bundle/web-app/cordis.patch.yml`
- Create: `packages/bundle/web-app/tests/readiness.spec.ts`
- Modify: `packages/bundle/web-app/README.md`

**Interfaces:**
- Produces: `GET /__dsh/ready` returns `204` only after the web listener and static frontend route are ready.
- Consumes: existing web startup host/port resolution.

- [ ] **Step 1: Write failing readiness test**

```ts
it('serves readiness only after the configured web listener starts', async () => {
  const app = await bootWebApp({ host: '127.0.0.1', port: 0 })
  await expect(fetch(`${app.origin}/__dsh/ready`)).resolves.toMatchObject({ status: 204 })
})
```

- [ ] **Step 2: Run focused red test**

Run: `pnpm vitest run packages/bundle/web-app/tests/readiness.spec.ts`

Expected: FAIL because no readiness route exists.

- [ ] **Step 3: Add route through the web-app startup contribution**

```ts
ctx.effect(() => ctx.webserver.route('GET', '/__dsh/ready', () => new Response(null, { status: 204 })))
```

Register only after the listener-owned web app completes startup; retain command-line host and port precedence.

- [ ] **Step 4: Run focused green test and typecheck**

Run: `pnpm vitest run packages/bundle/web-app/tests/readiness.spec.ts && pnpm exec tsc -b packages/bundle/web-app`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bundle/web-app
git commit -m "feat: expose web profile readiness"
```

### Task 2: Build isolated desktop lifecycle module

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/backend.ts`
- Create: `apps/desktop/src/paths.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/ipc.ts`
- Create: `apps/desktop/tests/backend.spec.ts`
- Create: `apps/desktop/tests/paths.spec.ts`
- Create: `apps/desktop/README.md`

**Interfaces:**
- `DesktopPaths.resolve(appData: string): DesktopPaths` returns user-owned `.env`, sessions, settings, and logs paths.
- `DshBackend.start(): Promise<BackendReady>` starts one packaged CLI child; `stop(): Promise<void>` stops that child only.
- `BackendReady` contains `origin: 'http://127.0.0.1:3080'`.

- [ ] **Step 1: Write failing path and lifecycle tests**

```ts
it('keeps mutable data outside the installation directory', () => {
  expect(resolveDesktopPaths('C:/Users/A/AppData/Local')).toMatchObject({ home: 'C:/Users/A/AppData/Local/DSH Desktop' })
})

it('stops only the spawned backend process tree', async () => {
  const backend = createBackend(fakeChildFactory)
  await backend.start()
  await backend.stop()
  expect(fakeChildFactory.killOwnedTree).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: Run focused red tests**

Run: `pnpm vitest run apps/desktop/tests/paths.spec.ts apps/desktop/tests/backend.spec.ts`

Expected: FAIL because desktop module does not exist.

- [ ] **Step 3: Implement paths and backend supervisor**

```ts
export const DESKTOP_ORIGIN = 'http://127.0.0.1:3080'
export const DESKTOP_HOST = '127.0.0.1'
export const DESKTOP_PORT = 3080
```

Pass `DSH_HOME` and `.env` location to the packaged CLI; poll only `GET /__dsh/ready`; on timeout include bounded child log tail. Refuse to replace an occupied non-owned port.

- [ ] **Step 4: Implement hardened Electron main/preload boundary**

```ts
new BrowserWindow({ webPreferences: { contextIsolation: true, nodeIntegration: false, preload } })
```

Expose only `backend.status`, `backend.restart`, and `desktop.requestClose`; validate every IPC sender is the main window.

- [ ] **Step 5: Run focused green tests and typecheck**

Run: `pnpm vitest run apps/desktop/tests/paths.spec.ts apps/desktop/tests/backend.spec.ts && pnpm exec tsc -b apps/desktop`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop
git commit -m "feat: add Electron DSH desktop host"
```

### Task 3: Add close confirmation and backend recovery

**Files:**
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/backend.ts`
- Modify: `apps/desktop/src/ipc.ts`
- Create: `apps/desktop/tests/main.spec.ts`

**Interfaces:**
- `DshBackend.status()` returns `idle | active | unavailable`.
- `confirmClose(status)` returns `wait | close`.

- [ ] **Step 1: Write failing close and crash tests**

```ts
it('cancels close when active work selects Wait', async () => {
  await expect(requestWindowClose(activeBackend, dialogWait)).resolves.toBe(false)
})

it('keeps the window open and exposes restart after backend exit', async () => {
  backend.emit('exit', 1)
  expect(window.webContents.send).toHaveBeenCalledWith('dsh:unavailable')
})
```

- [ ] **Step 2: Run focused red test**

Run: `pnpm vitest run apps/desktop/tests/main.spec.ts`

Expected: FAIL because close coordination is absent.

- [ ] **Step 3: Implement explicit lifecycle states**

Use DSH activity from its authenticated local status route; do not infer idle from DOM state. `Wait` prevents window close. `Close anyway` requests graceful shutdown, waits bounded time, then terminates the owned tree. Backend exit offers restart without replacing the Electron window.

- [ ] **Step 4: Run focused green tests**

Run: `pnpm vitest run apps/desktop/tests/main.spec.ts apps/desktop/tests/backend.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop
git commit -m "feat: coordinate desktop shutdown and recovery"
```

### Task 4: Package Windows application and prove clean launch

**Files:**
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/scripts/stage-runtime.mjs`
- Create: `apps/desktop/tests/package.e2e.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `.agents/notes/implemented/feature/2026-08-24-electron-desktop-host.md`

**Interfaces:**
- `pnpm run desktop:build` stages built DSH artifacts and generates an NSIS installer.
- `pnpm run desktop:smoke` launches packaged executable with a temporary `%LOCALAPPDATA%` home.

- [ ] **Step 1: Write failing packaged-launch test**

```ts
it('starts packaged DSH without system node or pnpm', async () => {
  const app = await launchPackagedDesktop({ userData: tempDir })
  await expect(app.window.url()).resolves.toBe('http://127.0.0.1:3080/')
})
```

- [ ] **Step 2: Run focused red test**

Run: `pnpm vitest run apps/desktop/tests/package.e2e.ts`

Expected: FAIL because no staged runtime or installer exists.

- [ ] **Step 3: Add electron-builder staging configuration**

Stage only built CLI, profile bundles, frontend dist, production packages, and embedded Node runtime. Configure NSIS Desktop and Start Menu shortcuts. Exclude source, tests, development dependencies, `.env`, and user data.

- [ ] **Step 4: Add Agent Note and README contracts**

Document ownership of the child process, port 3080 conflict policy, `.env` location, shutdown behavior, and test evidence. Keep implementation details in the package README and rationale in the Agent Note.

- [ ] **Step 5: Run package checks**

Run: `pnpm run desktop:build && pnpm vitest run apps/desktop/tests/package.e2e.ts && pnpm run desktop:smoke`

Expected: installer builds; clean launch works without system Node/pnpm.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop package.json pnpm-lock.yaml .agents/notes/implemented/feature/2026-08-24-electron-desktop-host.md
git commit -m "feat: package DSH Desktop for Windows"
```

### Task 5: Run proportionate integration verification

**Files:** Verify only.

- [ ] **Step 1: Run focused component checks**

Run: `pnpm vitest run packages/bundle/web-app/tests/readiness.spec.ts apps/desktop/tests && pnpm exec tsc -b packages/bundle/web-app apps/desktop`

Expected: PASS.

- [ ] **Step 2: Run Windows packaged smoke check**

Run: `pnpm run desktop:smoke`

Expected: Electron starts one DSH child on 127.0.0.1:3080; second launch focuses existing window; close behavior matches idle/active states.

- [ ] **Step 3: Commit any verification-only documentation correction**

```bash
git add <exact-files>
git commit -m "test: verify DSH Desktop lifecycle"
```
