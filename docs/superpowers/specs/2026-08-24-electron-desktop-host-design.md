# Electron Desktop Host Design

## Goal

Ship a Windows-only, self-contained desktop application that starts DeepSeek Harness with one desktop click, presents its web UI in an Electron window, and stops the owned backend when that window closes.

## Scope

The installer contains Electron, the built DSH web application, and its runtime dependencies. It does not require a workspace checkout, Node.js, or pnpm on the user's PC.

The app owns one DSH child process. It runs the `web` profile on `127.0.0.1:3080` with browser opening disabled, waits for a readiness endpoint, then loads `http://127.0.0.1:3080` in its sole Electron window.

The app binds only loopback. Electron IPC exposes only backend status, restart, and close coordination. The renderer has context isolation enabled and Node integration disabled.

## Data and configuration

The installed application is immutable under `Program Files\\DSH Desktop`. User-owned data is stored under `%LOCALAPPDATA%\\DSH Desktop`:

- `.env` contains `DEEPSEEK_API_KEY` and optional `DEEPSEEK_BASE_URL`;
- session, settings, and application logs survive updates and reinstallation;
- the current Windows user alone may read the data directory.

The packaged backend reads this data directory as its DSH home. It must never write configuration, sessions, or secrets into the installed application directory.

## Start and single-instance behavior

The Desktop shortcut and Start Menu entry launch Electron. Electron enforces one instance. A second launch focuses the existing window rather than starting another backend.

Before starting DSH, Electron checks `127.0.0.1:3080`. If its owned backend is already ready, Electron uses it. If an unrelated process owns the port, Electron reports the conflict and does not replace that process.

DSH emits a stable local readiness signal after its web server can serve the client. Electron applies a bounded startup timeout, presents the backend log tail on failure, and offers a controlled restart.

## Shutdown and recovery

Closing the window while DSH is idle requests graceful backend shutdown and waits briefly before terminating only the owned child process tree.

When a request, stream, or durable operation is active, Electron shows `Wait` and `Close anyway`. `Wait` cancels window closing. `Close anyway` records shutdown intent, performs graceful shutdown, then ends the owned child tree after the timeout.

If the backend exits unexpectedly, Electron preserves the window and shows a recoverable error with a `Restart backend` action. Restart uses the same user data directory and fixed port.

## Packaging and verification

Electron packages only production runtime files and DSH build artifacts. The Windows installer creates the Desktop and Start Menu entries.

Automated coverage proves startup readiness, single-instance focus, port-conflict refusal, backend crash recovery, idle close, active-work close confirmation, and persistence of local `.env` and session data. A Windows clean-machine smoke test proves launch without Node.js or pnpm.

## Non-goals

This release is Windows-only and supports one local DSH instance. It does not provide auto-update, a background tray service, LAN access, generic process termination, or macOS/Linux packaging.
