# Agent Note: Electron 桌面宿主控制权

Status: implemented

[English](2026-08-25-electron-desktop-host.md) | 中文

## 问题

桌面宿主向其 renderer 暴露本地 HTTP 监听器。profile 与 home patch 可以添加重复的配置项 id、替换插件名称，或选择非回环监听器。这些由用户控制的配置项不能决定桌面端的监听器或进程控制路由。

## 决策

最终桌面 patch 在所有 profile 与 home 层之后，对 `webserver` 和 `desktop-control` 使用根级 `upsert`。它保留唯一的规范 `@deepseek-ai/dsh-host-webserver` 配置项，地址为 `127.0.0.1:3080`，以及唯一的规范 `@deepseek-ai/dsh-host-desktop-control` 配置项，其 token 从 `DSH_DESKTOP_CONTROL_TOKEN` 解析。

Include 将根级 `upsert` 作为共享组合行为拥有。每个显式非空 id 都会在第一个匹配位置替换所有同 id 根配置项；没有匹配时追加。重建的 id 索引会让后续 patch 应用于规范配置项。`upsert` 会在 Include 协调其子树之前拒绝嵌套目标、重复或空 id，以及任何同级配置项操作。

`dsh-host-desktop-control` 通过 effect 作用域内的 web-server 注册，注册带认证且有特定方法的状态、identity 与关闭路由。状态始终精确为 `{ activity: 'idle' | 'active' }`。identity 只返回进程 PID 和 apply 生命周期的加密 nonce；关闭在 `202` 响应完成后才调用启动器退出回调，且该回调错误会被容纳。

`apps/desktop` 拥有一个 Electron-as-Node DSH 子进程。它将 DSH home、`.env`、会话、设置、有界日志和 PID/nonce/creation-FILETIME/token lease 放在 `%LOCALAPPDATA%\DSH Desktop` 下；启动会在子项写入前拒绝 reparse point，并将根目录和每个现有子项 DACL 重置为当前 SID。生产固定的已编码非交互 PowerShell 程序只通过进程环境接收根目录。

只有明确的回环 TCP 连接拒绝才允许 spawn。任何被占用的监听器必须证明 readiness、lease、已认证 PID/nonce identity 和当前 creation FILETIME 后才能重新连接；每个不匹配都是冲突。新子进程必须在写入 lease 前认证其已 spawn 的 PID。每次强制调用都会重新验证完整 identity，因此仅直接 spawn 永远不能允许重连后的终止。重新连接的 identity 会被有界监控。

Electron main process 持有单实例锁，在后端启动前构建并加固唯一的仅回环窗口，并排队早期 second-instance 聚焦。生命周期转换会串行化。原生对话框处理已删减的启动与后端失败恢复；renderer 没有 unavailable-event bridge。只有来自 Desktop-origin 主 frame 时，preload 才暴露冻结的状态、重启和关闭请求。每个 main-process handler 都会检查唯一 WebContents、其主 frame 和精确回环 origin。

## 考虑过的替代方案

- **按 id 覆盖 webserver 配置** — 否决；它会保留用户选择的插件名称和重复根配置项。
- **CLI 本地去重** — 否决；配置转储与实时 Include 重组合必须共享同一 patch 算法。
- **在关闭响应完成前退出** — 否决；进程退出可能截断已确认的响应。

## 后果

桌面 profile 不能选择其他监听器、端口、控制插件或控制 token。其他 Include 调用方可以在最终层必须拥有一个配置项时使用根级 `upsert`；格式错误的声明会快速失败，而不会丢弃同级字段。桌面控制不拥有本地生命周期状态，dispose 会移除全部路由。Desktop 只接受 Windows 本地用户数据根目录、一个 Electron 窗口和一个 DSH 子进程；installer 暂存与此生命周期拥有方分离。

## 验证

`packages/boot/app-boot/tests/config-dump.spec.ts` 固定替换、追加、仅根级以及无效 `upsert` 行为。`apps/cli/tests/desktop-control.e2e.ts` 启动并实时重组合冲突的 profile 与 home webserver/control 配置项。`packages/host/desktop-control/tests/desktop-control.spec.ts` 覆盖认证、identity、关闭顺序、无效 token 配置以及路由 dispose。`apps/desktop/tests` 覆盖真实 Windows DACL 重置、reparse 安全调用、完整 lease 验证、TCP 占用、精确 identity/FILETIME 重新连接与终止门、重新连接监控、串行生命周期、主 frame/origin IPC、preload 门控、早期聚焦、原生恢复、窗口加固和关闭选择。
