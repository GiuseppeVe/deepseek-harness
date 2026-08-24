# DSH Desktop

[English](README.md) | 中文

`@deepseek-ai/dsh-desktop` 是 Windows 专用 Electron 宿主，拥有一个本地 DSH Web 后端。

## Runtime

Electron 以 `ELECTRON_RUN_AS_NODE=1` 启动自身可执行文件，并将已暂存的 DSH CLI 项作为 `dsh web --no-open --host 127.0.0.1 --port 3080 --patch <desktop patch>` 运行。

后端只监听 `http://127.0.0.1:3080`；ready 监听器若其 lease token 未同时被 readiness 和 Desktop 状态路由接受，就是端口冲突，既不会被接管也不会被终止。

一个 Electron 实例持有单实例锁。后续启动会恢复并聚焦现有窗口，不会启动另一后端。

## Data and ownership

可变数据位于 `%LOCALAPPDATA%\DSH Desktop`：DSH home、`.env`、会话、设置、有界日志和后端 lease。

Desktop 创建可变子项前会创建此根目录，并将其 Windows ACL 限制为已验证的当前 `DOMAIN\user`；ACL 命令失败会停止启动。

lease 只记录已认证子进程 PID 和控制 token。Electron 不会将 token 放入 CLI 参数、日志、lease 诊断、preload 或 renderer IPC。它只会强制终止其保留或新 token 已认证 Desktop 控制路由的 PID。

## Window and lifecycle

唯一的 BrowserWindow 启用 `contextIsolation` 并禁用 Node integration。它只加载回环 origin，拒绝外部窗口，并通过 preload IPC 仅暴露冻结的 `backend.status`、`backend.restart` 和 `desktop.requestClose` 操作。

空闲关闭请求后端优雅停止。活跃工作显示 `Wait` 和 `Close anyway`；后者等待已配置宽限期后，只强制终止已拥有的子进程树。意外子进程退出保留窗口并报告 `dsh:unavailable`，使 renderer 可以请求重启。

## Limitations

此源代码级包不暂存 CLI runtime，也不创建 installer。Windows 打包和无 Node 或 pnpm 的干净机器启动覆盖属于 Desktop 打包工作。
