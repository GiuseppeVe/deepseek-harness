# Agent Note: Electron 桌面宿主控制权

Status: implemented

[English](2026-08-25-electron-desktop-host.md) | 中文

## 问题

桌面宿主向其 renderer 暴露本地 HTTP 监听器。profile 与 home patch 可以添加重复的配置项 id、替换插件名称，或选择非回环监听器。这些由用户控制的配置项不能决定桌面端的监听器或进程控制路由。

## 决策

最终桌面 patch 在所有 profile 与 home 层之后，对 `webserver` 和 `desktop-control` 使用根级 `upsert`。它保留唯一的规范 `@deepseek-ai/dsh-host-webserver` 配置项，地址为 `127.0.0.1:3080`，以及唯一的规范 `@deepseek-ai/dsh-host-desktop-control` 配置项，其 token 从 `DSH_DESKTOP_CONTROL_TOKEN` 解析。

Include 将根级 `upsert` 作为共享组合行为拥有。每个显式非空 id 都会在第一个匹配位置替换所有同 id 根配置项；没有匹配时追加。重建的 id 索引会让后续 patch 应用于规范配置项。`upsert` 会在 Include 协调其子树之前拒绝嵌套目标、重复或空 id，以及任何同级配置项操作。

`dsh-host-desktop-control` 通过 effect 作用域内的 web-server 注册，注册带认证且有特定方法的状态与关闭路由。关闭在完成 `202` 响应后才调用并容纳启动器退出回调。

## 考虑过的替代方案

- **按 id 覆盖 webserver 配置** — 否决；它会保留用户选择的插件名称和重复根配置项。
- **CLI 本地去重** — 否决；配置转储与实时 Include 重组合必须共享同一 patch 算法。
- **在关闭响应完成前退出** — 否决；进程退出可能截断已确认的响应。

## 后果

桌面 profile 不能选择其他监听器、端口、控制插件或控制 token。其他 Include 调用方可以在最终层必须拥有一个配置项时使用根级 `upsert`；格式错误的声明会快速失败，而不会丢弃同级字段。桌面控制不拥有本地生命周期状态，dispose 会移除两个路由。

## 验证

`packages/boot/app-boot/tests/config-dump.spec.ts` 固定替换、追加、仅根级以及无效 `upsert` 行为。`apps/cli/tests/desktop-control.e2e.ts` 启动并实时重组合冲突的 profile 与 home webserver/control 配置项。`packages/host/desktop-control/tests/desktop-control.spec.ts` 覆盖认证、关闭顺序、无效 token 配置以及路由 dispose。
