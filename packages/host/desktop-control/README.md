# @deepseek-ai/dsh-host-desktop-control

English | [中文](README.zh.md)

Authenticated control routes for a Desktop launcher. This plugin exposes only aggregate agent activity and a bounded shutdown request; it has no browser transport, renderer IPC, persistence, command-line, or logging surface for its bearer credential.

## Configuration

`token` is a required bearer credential of at least 32 characters. Desktop generates it with high entropy and passes it only through the child process environment. The final Desktop overlay reads `DSH_DESKTOP_CONTROL_TOKEN`; applications must keep that overlay last so user profile and home patches cannot expose the server or replace its fixed port.

## Routes

`GET /__dsh/desktop/status` requires `Authorization: Bearer <token>` and returns exactly one JSON field: `{"activity":"idle"}` or `{"activity":"active"}`. Activity is active when any current `ctx.agents.list()` item has `status === 'running'`.

`POST /__dsh/desktop/shutdown` requires the same credential. It returns `202`, then calls launcher-provided `ctx.appExit(0)`; it never exits the process directly. Activation fails when that launcher hook is absent. Other methods return `405`; missing or invalid credentials return `401`. Same-length credentials use `timingSafeEqual`. The routes add no CORS headers.

Route registrations are `ctx.effect()` resources, so unloading this plugin removes both controls.

## Model experience

None. These host-only routes do not add model-visible input, tools, prompts, or session events.

#### KV Cache impact

None.

## Known limitations and deferrals

- Status is process-wide and intentionally coarse: it reports only whether at least one agent is running, not task progress or a selected agent's state.
