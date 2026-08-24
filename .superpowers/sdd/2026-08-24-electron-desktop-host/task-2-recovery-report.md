# Task 2 recovery report

## Summary

Recovered Task 2's desktop control authority and final Desktop overlay. The package provides authenticated status and controlled-shutdown routes, while the final overlay keeps the web server on loopback port 3080.

Recovery found one security defect in the partial implementation: an unauthenticated request using an unsupported method returned `405`. The route now authenticates before method validation, so every missing or invalid credential receives `401`; authenticated unsupported methods receive `405`.

No Electron lifecycle, window, packaging, or installer work was started.

## Exact files

- `apps/cli/package.json`
- `apps/cli/tests/desktop-control.e2e.ts`
- `apps/desktop/runtime/desktop.cordis.patch.yml`
- `packages/host/desktop-control/package.json`
- `packages/host/desktop-control/tsconfig.json`
- `packages/host/desktop-control/src/index.ts`
- `packages/host/desktop-control/src/invariant.ts`
- `packages/host/desktop-control/tests/desktop-control.spec.ts`
- `packages/host/desktop-control/README.md`
- `packages/host/desktop-control/README.zh.md`
- `packages/host/desktop-control/README.i18n.yaml`
- `tsconfig.host.json`
- `pnpm-lock.yaml` (only CLI and desktop-control importer hunks)

## Verification

| Command | Result |
| --- | --- |
| `pnpm vitest run packages/host/desktop-control/tests/desktop-control.spec.ts` | Initial red: failed as expected with `expected 405 to be 401`; final green: 3/3 passed. |
| `pnpm vitest run --config vitest.e2e.config.ts apps/cli/tests/desktop-control.e2e.ts` | Passed: 1/1. |
| `pnpm exec tsc -b packages/host/desktop-control apps/cli` | Passed. |
| `pnpm run verify-translation-pairing --write packages/host/desktop-control/README.md` | Passed; no sidecar rewrite needed. |
| staged translation-pairing, lint, third-party-notices, whitespace, vendor-manifest pre-commit hooks | Passed. |
| `git diff --cached --check` | Passed before implementation commit. |

`pnpm vitest run apps/cli/tests/desktop-control.e2e.ts` was not a product failure: the default Vitest configuration discovers only `*.spec.ts`. The e2e configuration above is required and passed.

## Commits

- `d2573e69da feat: add desktop control authority`

This recovery report is committed separately from the implementation.

## Residual risks

- Repository-wide `pnpm run verify-translation-pairing` still fails for unrelated unpaired documentation already present in the worktree; Task 2's staged README pair passed the pre-commit check.
- Real Electron lifecycle and packaged-runtime coverage remain later-task work. This task covers source-level control routes and final-overlay composition only.
