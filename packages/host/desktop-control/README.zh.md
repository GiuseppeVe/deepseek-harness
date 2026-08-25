# @deepseek-ai/dsh-host-desktop-control

[English](README.md) | 中文

面向 Desktop 启动器的已认证控制路由。此插件只暴露聚合 agent 活动与有边界的关停请求；它没有浏览器传输、renderer IPC、持久化、命令行或 bearer 凭证的日志接口。

## 配置

`token` 是至少 32 个字符的必填 bearer 凭证。Desktop 以高熵生成它，并且只通过子进程环境传入。最终 Desktop overlay 读取 `DSH_DESKTOP_CONTROL_TOKEN`；应用必须保持该 overlay 最后应用，令用户 profile 与 home patch 不能暴露服务器或替换固定端口。

## 路由

`GET /__dsh/desktop/status` 需要 `Authorization: Bearer <token>`，并且只返回一个 JSON 字段：`{"activity":"idle"}` 或 `{"activity":"active"}`。任一当前 `ctx.agents.list()` 项目的 `status === 'running'` 时，活动状态为 active。

`GET /__dsh/desktop/identity` 需要相同凭证，并返回当前进程 PID 与一个 apply 生命周期的加密 nonce。Desktop 将此私有响应与 Windows 进程 creation FILETIME 一起使用，以区分保留的后端与 PID 重用。identity 绝不记录、渲染或 preload。

`POST /__dsh/desktop/shutdown` 需要相同凭证。它返回 `202`，然后调用启动器提供的 `ctx.appExit(0)`；它绝不直接退出进程。缺少启动器钩子时，激活会失败。其他 method 返回 `405`；缺失或无效凭证返回 `401`。同长度凭证使用 `timingSafeEqual`。路由不添加 CORS header。

路由注册是 `ctx.effect()` 资源，因此卸载此插件会移除全部控制接口。

## 模型体验

无。这些仅宿主侧路由不会添加模型可见输入、工具、提示词或 session event。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 状态是进程级且刻意粗粒度：它只报告是否至少有一个 agent 正在运行，不报告任务进度或某个选定 agent 的状态。
