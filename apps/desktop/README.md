# DSH Desktop

English | [中文](README.zh.md)

`@deepseek-ai/dsh-desktop` is the Windows-only Electron owner for one local DSH web backend.

## Runtime

Electron starts its own executable with `ELECTRON_RUN_AS_NODE=1` and the staged DSH CLI entry as `dsh web --no-open --host 127.0.0.1 --port 3080 --patch <desktop patch>`.

The backend listens only at `http://127.0.0.1:3080`; a ready listener without a lease token accepted by both readiness and Desktop status routes is a port conflict and is neither adopted nor terminated.

One Electron instance holds the single-instance lock. Later launches restore and focus its existing window without starting another backend.

## Data and ownership

Mutable data lives under `%LOCALAPPDATA%\DSH Desktop`: DSH home, `.env`, sessions, settings, bounded logs, and the backend lease.

Before Desktop creates mutable descendants it creates this root and restricts its Windows ACL to the validated current `DOMAIN\user`; an ACL command failure stops startup.

The lease records only the authenticated child PID and control token. Electron keeps the token out of CLI arguments, logs, lease diagnostics, preload, and renderer IPC. It force-terminates only a PID whose retained or fresh token has authenticated the Desktop control route.

## Window and lifecycle

The sole BrowserWindow enables `contextIsolation` and disables Node integration. It loads only the loopback origin, denies external windows, and exposes only frozen `backend.status`, `backend.restart`, and `desktop.requestClose` operations through preload IPC.

Idle close requests graceful backend shutdown. Active work offers `Wait` and `Close anyway`; the latter waits for the configured grace period before forcing only the owned child tree. Unexpected child exit keeps the window open and reports `dsh:unavailable` so the renderer can request a restart.

## Limitations

This source-level package does not stage a CLI runtime or create an installer. Windows packaging and clean-machine launch coverage belong to the Desktop packaging work.
