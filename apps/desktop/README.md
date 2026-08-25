# DSH Desktop

English | [中文](README.zh.md)

`@deepseek-ai/dsh-desktop` is the Windows-only Electron owner for one local DSH web backend.

## Runtime

Electron starts its own executable with `ELECTRON_RUN_AS_NODE=1` and the staged DSH CLI entry as `dsh web --no-open --host 127.0.0.1 --port 3080 --patch <desktop patch>`.

Desktop probes loopback TCP before spawning. Only an explicit connection refusal is free; every connected, HTTP, non-HTTP, or other error outcome is occupied. An occupied listener is reattached only when readiness, the retained lease, the authenticated identity route, and the live process creation FILETIME all match. Every other occupied listener is a port conflict and is neither adopted nor terminated.

One Electron instance holds the single-instance lock. Later launches restore and focus its existing window without starting another backend.

## Data and ownership

Mutable data lives under `%LOCALAPPDATA%\DSH Desktop`: DSH home, `.env`, sessions, settings, bounded logs, and the backend lease.

Before Desktop creates mutable descendants it creates this root, rejects any reparse point in its existing tree, and resets the root and every existing descendant DACL to the current Windows SID. The fixed noninteractive PowerShell program receives the root only through process environment; a DACL failure stops startup.

The lease records the authenticated child PID, apply-lifetime nonce, Windows creation FILETIME, and control token. Electron keeps the nonce and token out of CLI arguments, logs, diagnostics, preload, and renderer IPC. A fresh child must report its spawned PID through the identity route before lease write. Reattach and force termination revalidate the exact authenticated identity and current FILETIME; direct spawn alone never authorizes a later force termination.

## Window and lifecycle

The sole BrowserWindow enables `contextIsolation` and web security, disables Node integration and webviews, loads only the loopback origin, and denies external windows and non-loopback main or subframe navigation. Preload exposes only frozen `backend.status`, `backend.restart`, and `desktop.requestClose` operations when Electron runs the Desktop-origin main frame. IPC requires the same WebContents, same main frame, and exact loopback origin.

The main process creates and hardens the one window before backend startup, so early second-instance requests queue a later focus. Backend start, restart, and stop transitions serialize. Idle close requests graceful backend shutdown. Active work offers `Wait` and `Close anyway`; the latter waits for the configured grace period before forcing only a fully revalidated owned identity. Redacted startup failures and direct or reattached backend failures use native Retry/Quit or Restart backend/Quit dialogs; loopback loads only after recovery succeeds.

## Limitations

This source-level package does not stage a CLI runtime or create an installer. Windows packaging and clean-machine launch coverage belong to the Desktop packaging work.
