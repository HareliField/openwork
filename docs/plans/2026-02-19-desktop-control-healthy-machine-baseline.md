# Desktop Control Healthy Machine Baseline

Date: 2026-02-19  
Status: Proposed  
Owners: Area 7 (Computer Health and Diagnostics)

## 1. Purpose

This document defines the minimum machine baseline agents must meet before taking desktop-control implementation tasks.

## 2. Baseline Requirements

1. Platform:
   - macOS (`darwin`) is required for real Screen Recording and Accessibility permission validation.
2. Toolchain:
   - Node.js `>=20`
   - pnpm `>=9`
3. Local workspace state:
   - Dependencies installed.
   - Desktop build output present at `apps/desktop/dist-electron/main/index.js`.
4. OS permissions for Screen Agent:
   - Screen Recording enabled.
   - Accessibility enabled.
   - Paths:
     - `System Settings > Privacy & Security > Screen Recording`
     - `System Settings > Privacy & Security > Accessibility`

## 3. Pre-Task Verification Commands

Run from repository root:

```bash
pnpm install --frozen-lockfile
pnpm -F @accomplish/desktop build
pnpm --dir apps/desktop exec node ../../scripts/desktop-control-healthcheck/startup-healthcheck.mjs
pnpm --dir apps/desktop exec playwright test --config ../../tests/desktop-control/playwright.config.ts
```

## 4. Pass Criteria

1. Startup healthcheck:
   - Output includes `[desktop-control-healthcheck] PASS`.
   - Printed JSON includes:
     - `readinessChecks` with `screen_capture`, `action_execution`, and `mcp_health`.
     - `readinessStatus: "ready"` for a fully healthy local machine.
2. Desktop-control Playwright guard suite:
   - Exits with status `0`.
   - Includes passing readiness bridge and screenshot/action reliability specs.

## 5. Status Interpretation And Remediation

| Readiness status | Meaning | Required action before coding |
|---|---|---|
| `ready` | Machine permissions and runtime dependencies are healthy. | Proceed with desktop-control tasks. |
| `needs_screen_recording_permission` | Screen Recording is not granted or is policy-restricted. | Enable Screen Recording for Screen Agent, then fully relaunch and re-run checks. |
| `needs_accessibility_permission` | Accessibility is not granted. | Enable Accessibility for Screen Agent, then fully relaunch and re-run checks. |
| `mcp_unhealthy` | MCP runtime runner or core skill entrypoints are missing/unhealthy. | Re-run `pnpm install`, rebuild desktop app, confirm skill entrypoints exist, then re-run checks. |
| `unknown` | Readiness probe timed out or failed unexpectedly. | Re-run checks once; if still unknown, collect logs and resolve runtime instability before coding. |

## 6. Agent Task Gating

1. Do not start reliability or behavior-change implementation if baseline checks fail.
2. If baseline cannot reach `ready`, limit work to docs/planning-only tasks and note the blocker in your PR/issue.
3. Attach failing command output and `tests/desktop-control/artifacts` paths when escalating machine baseline issues.
