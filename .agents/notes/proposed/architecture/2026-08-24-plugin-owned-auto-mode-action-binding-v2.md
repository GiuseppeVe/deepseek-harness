# Agent Note: Zero-trust Guardian and plugin-owned action binding for resilient auto mode

Status: proposed

English | [中文](2026-08-24-plugin-owned-auto-mode-action-binding-v2.zh.md)

## Problem

The initial action-binding proposal protects a trusted DSH process from an untrusted model, tool arguments, repository content, and tool output. It does not contain a third-party plugin loaded into that process: such code can bypass a Cordis listener, call Node facilities directly, or alter another plugin's live state. A digest only proves equality inside a trusted execution path; it cannot reduce the privileges of hostile same-process code.

An operator needs two compatible choices: run an unverified third-party plugin without making it part of DSH's trusted computing base, or explicitly accept one exact plugin artifact as trusted. Both choices need durable provenance, immediate revocation, restart-safe behavior, and an automatic permission decision that still names the exact effect it authorizes.

The existing Windows ACL sandbox reports partial enforcement. It reduces risk for child processes but cannot support a zero-trust isolation claim for arbitrary plugin code. Auto mode must not silently treat partial confinement as complete.

## Proposal

V2 keeps dsh-auto-mode as a composable Cordis plugin and adds a Guardian companion that starts before the DSH Loader. The Guardian is the deployment authority for plugin admission, local policy provenance, user trust grants, worker confinement, and capability tickets. It is not a plugin loaded into the DSH process.

The Guardian starts an auto-enabled DSH host only after it verifies the signed policy and exact host manifest. A missing, expired, malformed, or mismatched attestation prevents automatic decisions and leaves the ordinary human approval chain available. Workspace files, repository content, model output, and user settings cannot widen the managed policy.

### Trusted computing base and admission

The trusted DSH host contains only artifacts named by the signed manifest: the DSH runtime, dsh-auto-mode, its Guardian client, and other operator-approved host plugins. Before Node imports a host module or resolves a profile row, the Guardian verifies the canonical manifest signature, SHA-256 artifact digest, package identity, version, and declared host role. An unlisted host package or resolution root aborts the auto-enabled launch.

The Guardian owns a local canonical AutoModePolicy record. Its Ed25519 signature, trust-root public keys, and storage directory are protected by operating-system access controls outside a workspace. The policy names its revision, allowed host artifacts, deterministic denies and human checkpoints, reviewer route, capability limits, trust-grant lifetime limits, and the minimum confinement level required for untrusted workers. It has no remote control-plane dependency in V2.

The Guardian exposes a complete capability seam rather than a privileged ad-hoc channel: the Service Definition owns capability requests and one-time ticket types, a trusted-host Service Provider speaks the authenticated Guardian IPC protocol, and a proxy Consumer is the only route by which an external worker receives an effect. An external plugin artifact is never imported into the trusted DSH host.

### User trust grants

Only a local Guardian UI or CLI outside an agent session can create, revoke, or inspect a user trust grant. The operation displays the resolved artifact identity, version, SHA-256 digest, signer when available, requested capabilities, and selected trust level. A model, a plugin, a repository file, or an ordinary DSH tool call cannot invoke or synthesize this operation.

A trusted-isolated grant is the normal user decision. It names one exact artifact digest and capability subset, records an operator, timestamp, policy revision, optional expiry, and audit id, and runs that artifact only in an external worker through the capability proxy. It does not permit a future version, a different digest, or a publisher-wide wildcard.

A trusted-host grant requires a separate dangerous confirmation. It admits one exact artifact to the host manifest and therefore makes that artifact part of the trusted computing base. The grant is an explicit operator acceptance that the artifact can bypass auto-mode policy by using the host process directly; it is not an automatic permission exemption for its ordinary tool calls. A new digest always needs a new grant. Revoking a trusted-isolated grant invalidates outstanding tickets and stops its worker. Revoking a trusted-host grant terminates the host process, because hostile in-process code cannot be safely unloaded or contained after revocation.

User trust never changes a managed deny, an artifact mismatch, or a platform confinement verdict. A trusted-host grant is an explicit code-trust decision, not evidence that partial confinement became complete. No automatic promotion exists from trusted-isolated to trusted-host.

### Action binding, review, and capability redemption

In the trusted host, dsh-auto-mode prepends a tools/pre-execute listener after the registry has snapshotted and deep-frozen JSON arguments. It builds a canonical action record containing the action version, Guardian attestation id, policy revision, session id, call id, root call id, tool name, complete arguments, workspace root, requested workdir, and declared sandbox widening. SHA-256 over that complete value is the action digest.

The approval waterfall resolves automatically only when its session and call id name one live action record. Deterministic managed denies reject before a model call. Managed human checkpoints, unknown capability descriptors, unsafe redaction, and unbound asks defer to the human chain. Every remaining action reaches the pinned reviewer; classifyAllShell makes this true for every shell action.

The reviewer receives recorded user intent, a secret-redacted canonical action projection, action digest, redacted trust facts, and structured taint metadata. It never receives assistant reasoning or raw tool results. A reviewer allow creates an in-memory one-use grant. The prepended tools/execute listener rebuilds the record, compares the complete digest, and consumes that grant before a tool body runs. Missing, changed, cancelled, expired, or replayed grants prevent the body from running.

An external worker requests a named capability through the proxy. The trusted proxy canonicalizes the actual capability request, and the Guardian redeems only a one-use, expiring ticket bound to its attestation id, action digest, capability descriptor, and nonce. The Guardian derives request identity itself; a worker-supplied digest or trust label is not authority. Sandbox widening consumes the matching one-use decision immediately before the privileged effect and never adds a generic outer approval ask.

### Taint, recovery, and platform enforcement

A bounded probe scans textual projections of successful and error tool results after execution. Raw output remains outside the reviewer briefing. The probe records only a bounded taint category, severity, source identity, and redacted evidence marker. High-confidence taint forces a human checkpoint for the next affected write, network, credential, or external-worker action; lower-confidence taint raises reviewer risk. The probe is not an allow authority.

Reviewer failure, timeout, invalid verdict, cancellation, unsafe redaction, ticket failure, or unbound action defers to the human chain. A deterministic deny returns a stable remediation category. Action-integrity failure, ticket replay, or repeated policy and taint failures suspend auto mode through a durable circuit breaker and require the user to leave and re-enter the posture after inspection; retry never reuses a rejected or consumed grant.

Action records, reviewer jobs, tickets, and grants are process-local. Restart, HMR, cancellation, disposal, or Guardian reconnect drops them all. The session log retains redacted policy revision, Guardian attestation digest, review outcome, action digest, taint summary, and circuit-breaker state, never raw action secrets. On restart the Guardian verifies policy and manifest again, the plugin restores durable facts, and a retry begins as a new action under the current policy.

The Guardian starts a trusted-isolated worker and redeems its capability tickets only when its selected platform provider reports complete confinement. On a platform with partial or unknown enforcement, including the current Windows ACL provider, it may run the signed trusted host but refuses to start a trusted-isolated worker. The operator must use a fully isolated VM or equivalent complete provider, or make the separate trusted-host code-trust decision. A trusted-host grant remains an explicit acceptance of host-code risk, never evidence that platform confinement is complete.

### Operator controls and security references

The Guardian provides defaults, config, and critique inspection commands. They show the effective non-secret policy, manifest and trust provenance, confinement verdict, reviewer route, active suspension, and the exact reason an action could not be automatic. Trust add, trust host, trust revoke, and trust list are local operator commands; model-visible controls may request a human action but cannot perform it.

The reviewer and probe split follows the documented Claude Auto Mode rule that a classifier must not receive raw tool results. The managed precedence and explicit reviewer route follow the same configuration model, while the Guardian adds the isolation and admission authority that a same-process plugin cannot provide.

- [Claude Code glossary](https://code.claude.com/docs/en/glossary)
- [Configure auto mode](https://code.claude.com/docs/en/auto-mode-config)
- [Claude Code secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)
- [Windows ACL confinement limitation](../../../../packages/sandbox/sandbox-local/README.md)

## Alternatives considered

**Plugin-only action binding.** Rejected. The earlier [plugin-owned proposal](../../rejected/architecture/2026-08-24-plugin-owned-auto-mode-action-binding.md) correctly binds a reviewer decision to an immutable action, but it assumes every loaded plugin is trusted. It cannot contain a third-party plugin that shares its process.

**Persist grants across restart.** Rejected. A grant belongs to one live execution and reviewer transaction. Persisting it would create a replay authorization after the execution lifetime has ended.

**Treat every user-trusted publisher as trusted-host forever.** Rejected. Publisher-wide trust silently accepts future code. V2 grants only an exact artifact digest; a new artifact needs a new operator decision.

**Use the current Windows ACL sandbox as the zero-trust worker root.** Rejected. Its documented partial enforcement is useful defense in depth but does not meet the Guardian's complete-confinement requirement.

**Show raw tool results to the reviewer.** Rejected. Tool output can carry indirect prompt injection. Taint metadata conveys risk without allowing that text to steer a permission decision.

## Acceptance criteria

- A Guardian-verifiable policy and host manifest are required before full automatic decisions start.
- An unverified or trusted-isolated plugin never loads into the DSH host process and obtains effects only through a one-use capability ticket.
- A local operator can grant, inspect, expire, and revoke trust for one exact artifact; trusted-host elevation requires distinct dangerous confirmation and host termination on revocation.
- Every automatic tool or sandbox decision is bound to a complete immutable action record, policy revision, and one-use grant; mismatch or replay runs no body or privileged effect.
- Reviewer input excludes raw tool results and secrets, while bounded taint metadata affects later risk handling without becoming an allow authority.
- Restart restores attested policy, audit, taint, and suspension facts but never grants, tickets, action records, or reviewer jobs.
- Partial confinement refuses trusted-isolated worker execution and capability tickets, including on the current Windows ACL provider.
- Focused unit, real tool-pipeline, Guardian launch, IPC-ticket, revocation, restart, tamper, platform-confinement, and keyless transcript tests prove these properties.

## Risks

Trusted-host is deliberate code-execution trust. An operator who grants it accepts that the artifact can bypass the policy plugin; the dangerous confirmation and exact-digest scope make that loss explicit but cannot remove it.

Complete worker isolation can be unavailable on a developer machine, especially on Windows. This reduces unattended third-party-plugin throughput until a verified VM or equivalent provider is installed; it is safer than mislabeling partial confinement as zero trust.

The Guardian and its signing keys become security-critical operational dependencies. Lost trust roots, corrupt policy storage, or a failed Guardian keep auto mode human-gated until an operator repairs the managed deployment. This fail-closed cost is intentional.
