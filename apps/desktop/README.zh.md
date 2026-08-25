# DSH Desktop

[English](README.md) | 中文

`@deepseek-ai/dsh-desktop` 是 Windows 专用 Electron 宿主，拥有一个本地 DSH Web 后端。

## Runtime

Electron 以 `ELECTRON_RUN_AS_NODE=1` 启动自身可执行文件，并将已暂存的 DSH CLI 项作为 `dsh web --no-open --host 127.0.0.1 --port 3080 --patch <desktop patch>` 运行。

Desktop 在 spawn 前探测回环 TCP。只有明确的连接拒绝表示端口空闲；已连接、HTTP、非 HTTP 或其他错误结果都表示端口被占用。被占用的监听器只有在 readiness、保留的 lease、已认证 identity 路由和实时进程 creation FILETIME 全部匹配时才会重新连接。其他被占用监听器都是端口冲突，既不会被接管也不会被终止。

一个 Electron 实例持有单实例锁。后续启动会恢复并聚焦现有窗口，不会启动另一后端。

## Data and ownership

可变数据位于 `%LOCALAPPDATA%\DSH Desktop`：DSH home、`.env`、会话、设置、有界日志和后端 lease。

Desktop 创建可变子项前会创建此根目录，以不跟随 reparse point 的方式打开每个现有项，拒绝 reparse point，并通过同一 handle 将根目录及每个现有子项的 DACL 重置为当前 Windows SID。固定的非交互 PowerShell 程序只通过进程环境接收根目录；DACL 失败会停止启动。

lease 记录已认证子进程 PID、apply 生命周期 nonce、Windows creation FILETIME 和 control token。Electron 不会将 nonce 或 token 放入 CLI 参数、日志、诊断、preload 或 renderer IPC。新子进程必须先通过 identity 路由报告其已 spawn 的 PID，才会写入 lease；在此期间退出或 ready identity 不匹配都会使启动失败且不发布 lease。Electron 只会在所有权发布前通过仍直接持有的子进程 handle 将该子进程静止。重新连接和之后的强制终止都会重新验证精确的已认证 identity 与当前 FILETIME。

## Window and lifecycle

唯一的 BrowserWindow 启用 `contextIsolation` 和 web security，禁用 Node integration 与 webview，只加载回环 origin，并拒绝外部窗口及非回环导航或重定向。只有 Electron 在 Desktop-origin 主 frame 中运行时，preload 才会暴露冻结的 `backend.status`、`backend.restart` 和 `desktop.requestClose` 操作。IPC 要求同一 WebContents、同一主 frame 和精确的回环 origin。

main process 会在后端启动前创建并加固唯一窗口，因此早期 second-instance 请求会排队以便稍后聚焦。后端 start、restart 和 stop 转换会串行化。空闲关闭请求后端优雅停止。活跃工作显示 `Wait` 和 `Close anyway`；后者等待已配置宽限期后，只会强制终止经过完整重新验证的已拥有 identity。已删减的启动失败以及直接或重新连接的后端失败使用原生 Retry/Quit 或 Restart backend/Quit 对话框；只有恢复成功后才加载回环地址。

## Limitations

此源代码级包不暂存 CLI runtime，也不创建 installer。Windows 打包和无 Node 或 pnpm 的干净机器启动覆盖属于 Desktop 打包工作。
