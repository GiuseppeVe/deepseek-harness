# Agent Note: 弹性 auto mode 的插件自有 action binding

Status: rejected — 零信任 Guardian 提案已取代本提案；同进程插件信任无法约束第三方代码

[English](2026-08-24-plugin-owned-auto-mode-action-binding.md) | 中文

[零信任 Guardian 与插件自有 action binding](../../proposed/architecture/2026-08-24-plugin-owned-auto-mode-action-binding-v2.zh.md)取代本提案。保留此记录，是因为让普通同进程插件监管第三方插件是一种会反复出现的不安全捷径。

## 问题

`dsh-auto-mode` 当前根据工具名称和自由文本 reason 决定一个审批请求。它不会接收注册表将要执行的不可变工具参数。因此，reviewer 可以批准某个 action 描述，却无法证明被授权的决定准确指向会到达工具主体的命令、文件目标、沙箱请求或工作区。

该包也只在进程内存中保存 trust 信息和 reviewer 状态。重启、HMR 或中断的 reviewer 调用绝不能把先前的决定变成可重用 grant；而重启后恢复的会话必须获得同样的持久策略、trust 快照、审计轨迹和 fail-closed 行为。

## 提议

把 action binding 保留在 `dsh-auto-mode` 内；不扩大 core approval、tools 或 sandbox API。该包围绕注册表自有的 execution record 组合现有 `tools/pre-execute`、`approval/request` 和 `tools/execute` 扩展点。注册表在策略 listener 运行前已经快照并 deep-freeze JSON 参数。

该包把其他已挂载插件视为可信的同进程代码。其安全目标是非可信模型、工具参数、工具输出、仓库内容和远程内容。直接访问该进程的恶意插件不在此策略层范围内，需要更低层的 capability 设计。

### Action record

在下游策略运行前，带 `prepend` 的 `tools/pre-execute` listener 捕获 canonical action record：action 版本、session id、call id、root call id、工具名、deep-freeze 参数、工作区根、请求的 workdir 和声明的沙箱升权。稳定 digest 覆盖完整 canonical JSON 值。该 listener 使 execution identity 字段不可变，只保留 `signal` 可供已记录的 execute wrapper 修改。

只有当审批请求的 session 和 call id 映射到一个活跃 action record 时，auto reviewer 才会解析它。其 briefing 包含已脱敏的 canonical action view 和完整 action digest，而不是信任 ask reason。带 secret 的字段和凭证形态值会被脱敏；无法安全脱敏的 action 会委托给人工。没有 action 的审批请求也会委托给人工链，不能获得自动 grant。

reviewer allow 创建一个绑定该 digest 的内存一次性 grant。对于普通工具 ask，带 `prepend` 的 `tools/execute` listener 从实时 execution 重建 action、比较 digest、只消费一次匹配 grant；遇到缺失、变化或重放 grant 时，在工具主体之前返回错误。沙箱升权 ask 发生在已经准入的工具主体内、特权效果之前：冻结参数携带请求模式，匹配的 reviewer 决定由该升权 transaction 消费。当工具会自己发出升权审批时，该包不再增加外层通用 ask。

### Decision order

1. 确定性的受管 deny 规则无需模型调用就会拒绝。
2. 确定性的受管 ask 规则会路由给人工，不产生自动 grant。
3. 显式受管 allow 规则和狭窄安全路径只有在其结构化 action matcher 成功时才可通过。
4. 其余每个 action 都会到达 blind reviewer；启用 `classifyAllShell` 时包括每个 shell action。
5. reviewer 失败、超时、取消、未绑定 action、无效 verdict 或 circuit-breaker 暂停会委托给人工链。

规则处理完整的结构化 action，绝不处理被截断的 JSON 字符串。受管配置拥有 deny、ask、reviewer route、策略版本和限制。用户全局设置只能添加描述性环境条目；工作区文件绝不能提供 auto-mode 策略。

### Durability and restart

action record 和 grant 有意保持为进程本地状态。插件 dispose、HMR、服务器重启或取消会中止活跃 reviewer 工作，并丢弃每个 pending 或已发出的 grant。恢复后的会话绝不会继续或消费重启前 grant；新的 action 必须通过当前策略并接受全新 review。

该包为 trust 快照、review 结果、策略版本、action digest 和 circuit-breaker 暂停写入持久的插件自有事件。启动时它从 session event log 重建这些事实，为该会话复用第一份已脱敏 remote 快照，并让已暂停会话保持人工检查，直到用户离开 auto posture 后再切回。完整 action 参数或 secret 不会在审计事件中重复，因为持久工具调用事件仍是其真源。

### Reviewer, trust, and probes

enforced mode 要求显式固定 reviewer route 和非空的版本化受管策略。缺失或格式错误的 enforcement 配置会在插件加载时快速失败；`observe` 仍不作决定。reviewer 调用接收请求 abort signal 和受限 deadline。blind briefing 包含用户写入的 intent、已脱敏的 canonical action view、其完整 digest 和已脱敏 trust 事实，但排除 assistant reasoning 和工具结果。

Git remote 凭证会在持久化或进入 reviewer 输入前删除。自定义 probe pattern 在配置加载时验证并施加边界。结果 probe 扫描有边界的文本投影，包括 error result，并保持补充性的 prompt-injection 信号，而不是权限权威。

### Verification

测试使用真实工具流水线：reviewer allow 只会派发其精确 action；变化参数、变化 identity、缺失 record、重复 grant 和重放 grant 都不会调用主体。测试还覆盖沙箱升权、reviewer 取消、插件 dispose、重启恢复、持久暂停、策略优先级、完整 shell 分类、remote 脱敏、格式错误配置和 probe totality。一个 Loader 组合 smoke 证明重启会重建策略和 trust，同时丢弃 grant。

## Alternatives considered

**扩大 core approval 和 sandbox 接口。** 对此功能不予采纳，因为 DSH 已经提供不可变 execution record 和有序插件钩子。core capability 变更会扩大无关消费者，而插件可以在拥有工具流水线的位置绑定 grant。

**只信任 approval reason 或 call id。** 不予采纳，因为两者都不标识决定副作用的参数、目标或请求沙箱模式。

**持久化 grant 以便重启后继续 action。** 不予采纳，因为重启会使实时 execution 生命周期失效。重放先前 grant 会在创建 review transaction 之外授权 action。

**把 injection probe 当作权限决定。** 不予采纳，因为词法检测既有 false negative 也有 false positive。确定性策略和 action-bound review 仍是授权机制。

## Acceptance criteria

- 自动审批只对一个活跃、action-bound 的工具或沙箱请求可用。
- reviewer 看到稳定的 secret-redacted action view 和完整 action digest，绝不把自由文本 reason 当作 action identity。
- 参数、identity 或 grant 不匹配、重用、取消、dispose 或重启后，任何主体都不会运行。
- 受管策略优先级、完整 shell 分类、reviewer route 固定、配置验证和 trust 脱敏都在插件中强制执行。
- 恢复的会话保留策略、trust、审计和暂停事实，但绝不保留 grant 或 pending reviewer 工作。
- 聚焦 unit、真实组合、重启和 snapshot 覆盖证明所述行为。

## Risks

**可信插件假设。** 同进程插件可以故意违反 execution 约定或直接调用 approval。该包不能隔离加载到同一运行时的敌对代码。

**工具语义覆盖。** 通用 action record 保留完整参数，但高置信 capability 分类需要为新工具族维护 descriptor。未知 descriptor 保持 reviewer 或人工检查，而不进入 allow 路径。

**操作摩擦。** 严格的启动验证和持久 denial circuit breaker 可能停止无人值守的工作。这是刻意设计：错误部署或重复被拒绝的 action 必须要求 operator 或用户决定，而不是静默削弱权限。
