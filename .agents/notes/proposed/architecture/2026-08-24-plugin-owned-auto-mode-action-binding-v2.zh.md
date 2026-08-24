# Agent Note: 零信任 Guardian 与弹性 auto mode 的插件自有 action binding

Status: proposed

[English](2026-08-24-plugin-owned-auto-mode-action-binding-v2.md) | 中文

## 问题

最初的 action binding 提案保护可信 DSH 进程不受不可信模型、工具参数、仓库内容和工具结果影响。它不能约束加载在同一进程中的第三方插件：此类代码可以绕过 Cordis listener、直接调用 Node 能力，或改写其他插件的实时状态。digest 只能证明可信执行路径内的相等性；它不能降低敌对同进程代码的权限。

操作员需要两种可兼容的选择：运行未经验证的第三方插件而不把它纳入 DSH 的可信计算基，或者明确接受一个精确插件产物为可信。两种选择都需要持久的 provenance、即时撤销、可安全重启的行为，以及仍然准确指明所授权 effect 的自动权限决定。

现有 Windows ACL sandbox 报告的是部分强制执行。它能降低子进程风险，但不能为任意插件代码提供零信任隔离声明。auto mode 绝不能悄然把部分隔离当作完整隔离。

## 提案

V2 保留 dsh-auto-mode 作为可组合的 Cordis 插件，并增加一个在 DSH Loader 之前启动的 Guardian 配套进程。Guardian 是插件准入、本地策略 provenance、用户信任授权、worker 隔离和 capability ticket 的部署权威。它不是加载到 DSH 进程中的插件。

只有 Guardian 验证签名策略和精确 host manifest 后，才会启动启用 auto 的 DSH host。缺失、过期、格式错误或不匹配的 attestation 会阻止自动决定，同时保留普通的人类审批链。工作区文件、仓库内容、模型输出和用户设置都不能扩大受管策略。

### 可信计算基与准入

可信 DSH host 只包含签名 manifest 指定的产物：DSH runtime、dsh-auto-mode、其 Guardian client，以及其他操作员批准的 host 插件。在 Node import host 模块或解析 profile 配置项之前，Guardian 验证规范 manifest 签名、SHA-256 产物 digest、包身份、版本和声明的 host 角色。未列出的 host 包或解析根会中止启用 auto 的启动。

Guardian 拥有本地规范的 AutoModePolicy 记录。其 Ed25519 签名、trust-root 公钥和存储目录由工作区外的操作系统访问控制保护。策略指定其 revision、允许的 host 产物、确定性 deny 和人类检查点、reviewer route、capability 限制、信任授权生命周期限制，以及不可信 worker 所需的最低隔离等级。V2 不依赖远程 control plane。

Guardian 公开完整的 capability seam，而不是特权临时通道：Service Definition 拥有 capability request 和一次性 ticket 类型，可信 host 的 Service Provider 使用经过认证的 Guardian IPC 协议，proxy Consumer 是外部 worker 获得 effect 的唯一途径。外部插件产物绝不会被 import 到可信 DSH host。

### 用户信任授权

只有 agent session 外的本地 Guardian UI 或 CLI 可以创建、撤销或检查用户信任授权。该操作显示已解析的产物身份、版本、SHA-256 digest、可用时的 signer、请求的 capability 和所选信任等级。模型、插件、仓库文件或普通 DSH 工具调用都不能调用或伪造此操作。

trusted-isolated 授权是普通用户决定。它命名一个精确的产物 digest 和 capability 子集，记录操作员、时间戳、策略 revision、可选过期时间和 audit id，并且只通过 capability proxy 在外部 worker 中运行该产物。它不允许未来版本、不同 digest 或 publisher 范围的通配。

trusted-host 授权需要独立的危险确认。它把一个精确产物纳入 host manifest，因此使该产物成为可信计算基的一部分。该授权是操作员明确接受该产物可以通过直接使用 host 进程绕过 auto-mode 策略；它不是其普通工具调用的自动权限豁免。新的 digest 总是需要新的授权。撤销 trusted-isolated 授权会使未完成 ticket 失效并停止其 worker。撤销 trusted-host 授权会终止 host 进程，因为撤销后无法安全卸载或约束敌对同进程代码。

用户信任绝不改变受管 deny、产物不匹配或平台隔离结论。trusted-host 授权是明确的代码信任决定，不是部分隔离已变为完整隔离的证据。trusted-isolated 不存在自动提升为 trusted-host 的路径。

### Action binding、审查与 capability 兑换

在可信 host 中，dsh-auto-mode 在注册表已快照并 deep-freeze JSON 参数后 prepend 一个 tools/pre-execute listener。它建立规范 action record，其中包含 action 版本、Guardian attestation id、策略 revision、session id、call id、root call id、工具名称、完整参数、workspace root、请求的 workdir 和声明的 sandbox widening。对完整值计算 SHA-256 得到 action digest。

只有当 approval waterfall 的 session 和 call id 命名一个实时 action record 时，它才会自动解决。确定性的受管 deny 在模型调用之前拒绝。受管人类检查点、未知 capability descriptor、不安全 redaction 和未绑定的 ask 都转交人类链。每个其余 action 都到达 pinned reviewer；classifyAllShell 使每个 shell action 都满足这一点。

reviewer 接收已记录的用户意图、经 secret-redaction 的规范 action 投影、action digest、经 redaction 的 trust 事实和结构化 taint metadata。它绝不接收 assistant reasoning 或原始工具结果。reviewer allow 创建内存中的一次性授权。prepend 的 tools/execute listener 重建 record、比较完整 digest，并在工具主体运行前消费该授权。缺失、变化、取消、过期或重放的授权会阻止主体运行。

外部 worker 通过 proxy 请求具名 capability。可信 proxy 对实际 capability request 做规范化，Guardian 只兑换绑定 attestation id、action digest、capability descriptor 和 nonce 的一次性、会过期 ticket。Guardian 自行派生 request identity；worker 提供的 digest 或信任标签不是权威。sandbox widening 在特权 effect 前立刻消费匹配的一次性决定，并且绝不增加通用的外层审批 ask。

### Taint、恢复与平台强制执行

受限 probe 在执行后扫描成功和错误工具结果的文本投影。原始输出仍在 reviewer briefing 之外。probe 只记录受限的 taint 类别、严重性、来源身份和经 redaction 的 evidence marker。高置信度 taint 会为下一个受影响的写入、网络、凭证或外部 worker action 强制人类检查点；低置信度 taint 提高 reviewer 风险。probe 不是 allow 权威。

reviewer 失败、超时、无效 verdict、取消、不安全 redaction、ticket 失败或未绑定 action 都转交人类链。确定性 deny 返回稳定的 remediation 类别。action-integrity 失败、ticket 重放或重复策略和 taint 失败会通过持久 circuit breaker 暂停 auto mode，并要求用户检查后离开再重新进入该 posture；retry 绝不复用已拒绝或已消费的授权。

action record、reviewer job、ticket 和授权都只在进程内存在。restart、HMR、取消、dispose 或 Guardian 重连会丢弃它们。session log 保留经 redaction 的策略 revision、Guardian attestation digest、审查结果、action digest、taint 概述和 circuit-breaker 状态，绝不保留原始 action secret。restart 后 Guardian 再次验证策略和 manifest，插件恢复持久事实，retry 在当前策略下作为新 action 开始。

只有选定平台提供方报告完整隔离时，Guardian 才启动 trusted-isolated worker 并兑换其 capability ticket。在强制执行部分或未知的平台上，包括当前 Windows ACL provider，它可以运行签名的可信 host，但拒绝启动 trusted-isolated worker。操作员必须使用完全隔离的 VM 或等效完整 provider，或者作出单独的 trusted-host 代码信任决定。trusted-host 授权仍然只是明确接受 host 代码风险，绝不是平台隔离完整的证据。

### 操作员控制与安全参考

Guardian 提供 defaults、config 和 critique 检查命令。它们显示有效的非 secret 策略、manifest 和 trust provenance、隔离结论、reviewer route、活动 suspension，以及 action 不能自动化的精确原因。trust add、trust host、trust revoke 和 trust list 是本地操作员命令；model-visible 控制可以请求人类操作，但不能执行它。

reviewer 和 probe 的分离遵循 Claude Auto Mode 已文档化的规则：classifier 不得接收原始工具结果。受管优先级和明确 reviewer route 遵循相同的配置模型，而 Guardian 增加了同进程插件无法提供的隔离与准入权威。

- [Claude Code glossary](https://code.claude.com/docs/en/glossary)
- [配置 auto mode](https://code.claude.com/docs/en/auto-mode-config)
- [Claude Code 安全部署](https://code.claude.com/docs/en/agent-sdk/secure-deployment)
- [Windows ACL 隔离限制](../../../../packages/sandbox/sandbox-local/README.zh.md)

## 考虑过的替代方案

**仅插件 action binding。** 驳回。较早的[插件自有提案](../../rejected/architecture/2026-08-24-plugin-owned-auto-mode-action-binding.zh.md)正确地把 reviewer 决定绑定到不可变 action，但它假设每个加载的插件都可信。它不能约束与其共享进程的第三方插件。

**跨 restart 持久化授权。** 驳回。授权属于一个实时执行和 reviewer transaction。持久化它会在执行生命周期结束后产生重放授权。

**将每个用户信任的 publisher 永久视为 trusted-host。** 驳回。publisher 范围信任会悄然接受未来代码。V2 只授权精确产物 digest；新产物需要新的操作员决定。

**使用当前 Windows ACL sandbox 作为零信任 worker 根。** 驳回。其有文档记录的部分强制执行可作为纵深防御，但不满足 Guardian 的完整隔离要求。

**向 reviewer 展示原始工具结果。** 驳回。工具输出可能携带间接 prompt injection。taint metadata 传达风险，而不让这段文本操纵权限决定。

## 验收标准

- 在完整自动决定启动前，必须存在 Guardian 可验证的策略和 host manifest。
- 未验证或 trusted-isolated 插件绝不加载到 DSH host 进程，并且只通过一次性 capability ticket 获得 effect。
- 本地操作员可以为一个精确产物授予、检查、过期和撤销信任；trusted-host 提升需要不同的危险确认，撤销时终止 host。
- 每个自动工具或 sandbox 决定都绑定完整不可变 action record、策略 revision 和一次性授权；不匹配或重放不会运行主体或特权 effect。
- reviewer 输入排除原始工具结果和 secret，而受限 taint metadata 会影响后续风险处理，不会成为 allow 权威。
- restart 恢复 attested 策略、audit、taint 和 suspension 事实，但绝不恢复授权、ticket、action record 或 reviewer job。
- 部分隔离拒绝 trusted-isolated worker 执行和 capability ticket，包括当前 Windows ACL provider。
- 聚焦 unit、真实工具流水线、Guardian 启动、IPC ticket、撤销、restart、篡改、平台隔离和无密钥 transcript 测试证明这些属性。

## 风险

trusted-host 是有意的代码执行信任。授予它的操作员接受该产物可以绕过策略插件；危险确认和精确 digest 范围使这一代价明确，但不能消除它。

开发机可能没有完整 worker 隔离，尤其是 Windows。在安装经验证的 VM 或等效 provider 前，这会降低无人值守的第三方插件吞吐量；它比把部分隔离误标为零信任更安全。

Guardian 及其签名密钥成为安全关键的运维依赖。丢失 trust root、损坏策略存储或 Guardian 失败会使 auto mode 保持人类检查点，直到操作员修复受管部署。这一快速失败成本是有意的。
