# Agent Note: Plugin-owned action binding for resilient auto mode

Status: proposed

English | [中文](2026-08-24-plugin-owned-auto-mode-action-binding.zh.md)

## Problem

`dsh-auto-mode` currently decides an approval request from a tool name and a free-text reason. It does not receive the immutable tool arguments that the registry will execute. A reviewer can therefore approve an action description without proving that the granted decision names the command, file target, sandbox request, or workspace that reaches the tool body.

The package also holds trust information and reviewer state only in process memory. Restart, HMR, or an interrupted reviewer call must never turn a previous decision into a reusable grant, while sessions resumed after restart need the same durable policy, trust snapshot, audit trail, and fail-closed behavior.

## Proposal

Keep action binding inside `dsh-auto-mode`; do not widen the core approval, tools, or sandbox APIs. The package composes the existing `tools/pre-execute`, `approval/request`, and `tools/execute` extension points around the registry-owned execution record. The registry already snapshots and deep-freezes JSON arguments before policy listeners run.

The package treats other mounted plugins as trusted same-process code. Its security target is an untrusted model, tool arguments, tool output, repository content, and remote content. A malicious plugin with direct access to the process remains outside this policy layer and requires a lower-level capability design.

### Action record

Before downstream policy runs, a prepended `tools/pre-execute` listener captures a canonical action record: action version, session id, call id, root call id, tool name, deep-frozen arguments, workspace root, requested workdir, and declared sandbox widening. A stable digest covers the complete canonical JSON value. The listener makes execution identity fields immutable while leaving only `signal` mutable for documented execute wrappers.

The auto reviewer resolves an approval request only when its session and call id map to one live action record. Its briefing includes a redacted canonical action view and the full action digest rather than trusting the ask reason. Secret-bearing fields and credential-shaped values are redacted; an action that cannot be safely redacted delegates to a human. An action-less approval request also delegates to the human chain and cannot receive an automatic grant.

A reviewer allow creates an in-memory, one-use grant bound to that digest. For an ordinary tool ask, the prepended `tools/execute` listener rebuilds the action from the live execution, compares digests, consumes the matching grant once, and returns an error before the tool body on a missing, changed, or replayed grant. A sandbox widening ask happens inside an already admitted tool body, before its privileged effect: the frozen arguments carry the requested mode and the matching reviewer decision is consumed by that widening transaction. The package does not add an outer generic ask when the tool will issue its own widening approval.

### Decision order

1. Deterministic managed deny rules reject without a model call.
2. Deterministic managed ask rules route to a human without an automatic grant.
3. Explicit managed allow rules and narrow safe paths may pass only when their structured action matcher succeeds.
4. Every remaining action, including every shell action while `classifyAllShell` is enabled, reaches the blind reviewer.
5. Reviewer failure, timeout, cancellation, unbound action, invalid verdict, or circuit-breaker suspension delegates to the human chain.

Rules operate on complete structured actions, never a truncated JSON string. Managed config owns denies, asks, reviewer route, policy revision, and limits. User-global settings may add descriptive environment entries only; workspace files never supply auto-mode policy.

### Durability and restart

Action records and grants are process-local by design. Plugin disposal, HMR, server restart, or cancellation aborts active reviewer work and drops every pending or issued grant. A recovered session never resumes or consumes a pre-restart grant; a new action must pass the current policy and receive a fresh review.

The package writes durable plugin-owned events for its trust snapshot, review outcome, policy revision, action digest, and circuit-breaker suspension. On startup it rebuilds these facts from the session log, reuses the first redacted remote snapshot for that session, and leaves a suspended session human-gated until the user changes away from and back to the auto posture. No full action arguments or secrets are duplicated into the audit events because the durable tool-call event remains their source of truth.

### Reviewer, trust, and probes

Enforced modes require an explicit pinned reviewer route and a non-empty versioned managed policy. Missing or malformed enforcement config fails loudly at plugin load; `observe` remains non-deciding. Reviewer calls receive the request abort signal and a bounded deadline. The blind briefing contains user-authored intent, a secret-redacted canonical action view, its full digest, and redacted trust facts, but excludes assistant reasoning and tool results.

Git remote credentials are removed before persistence or reviewer input. Custom probe patterns are validated and bounded at config load. The result probe scans bounded textual projections, including error results, and remains a supplementary prompt-injection signal rather than authority for permissions.

### Verification

Tests use the real tool pipeline: a reviewer allow dispatches only its exact action; changed arguments, changed identity, missing records, duplicate grants, and replayed grants never invoke a body. Tests also cover sandbox widening, reviewer cancellation, plugin disposal, restart recovery, durable suspension, policy precedence, full shell classification, remote redaction, malformed config, and probe totality. A Loader-composed smoke proves that restart rehydrates policy and trust while discarding grants.

## Alternatives considered

**Widen core approval and sandbox interfaces.** Rejected for this feature because DSH already provides an immutable execution record and ordered plugin hooks. A core capability change would broaden unrelated consumers while the plugin can bind grants at the owning tool pipeline.

**Trust the approval reason or call id alone.** Rejected because neither identifies the arguments, target, or requested sandbox mode that determines the side effect.

**Persist grants to continue actions after restart.** Rejected because a restart invalidates the live execution lifetime. Replaying a prior grant would authorize an action outside the review transaction that created it.

**Treat the injection probe as a permission decision.** Rejected because lexical detection has false negatives and false positives. Deterministic policy and action-bound review remain the authorization mechanism.

## Acceptance criteria

- Automatic approval is available only to a live, action-bound tool or sandbox request.
- The reviewer sees a stable secret-redacted action view and full-action digest, and never relies on a free-text reason as the action identity.
- No body runs after an argument, identity, or grant mismatch, reuse, cancellation, disposal, or restart.
- Managed policy precedence, full shell classification, reviewer route pinning, configuration validation, and trust redaction are enforced in the plugin.
- Resumed sessions preserve policy, trust, audit, and suspension facts, but never grants or pending reviewer work.
- Focused unit, real-composition, restart, and snapshot coverage proves the stated behavior.

## Risks

**Trusted-plugin assumption.** A same-process plugin can intentionally violate execution contracts or call approval directly. This package cannot isolate hostile code loaded into the same runtime.

**Tool semantic coverage.** Generic action records preserve complete arguments, but high-confidence capability classification needs maintained descriptors for new tool families. Unknown descriptors remain reviewer- or human-gated rather than entering an allow path.

**Operational friction.** Strict startup validation and a persistent denial circuit breaker can stop unattended work. This is deliberate: a bad deployment or repeated denied action must require an operator or user decision rather than silently weakening permissions.
