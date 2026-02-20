# Desktop Control Reliability And Live Vision Spec

Date: 2026-02-13  
Status: Proposed  
Scope: `@accomplish/desktop` (Electron app + MCP skills)

## 1. Problem Statement

Users report four core failures:

1. The assistant cannot reliably capture screenshots.
2. The assistant cannot "see live" screen state, only single snapshots.
3. The assistant cannot reliably execute mouse/keyboard actions.
4. When tools fail, the assistant falls back to repetitive generic answers.

In this repo, the required capabilities already exist (`screen-capture` and `action-executor` skills), so the gap is primarily reliability, permission handling, observability, and orchestration.

## 2. Product Goals

1. Make screenshot and action tools work reliably on macOS with clear diagnostics.
2. Add practical "live vision" support (continuous frame sampling, not high-FPS streaming).
3. Prevent generic fallback loops when visual/action tools are unavailable.
4. Keep user control and safety gates for destructive actions.
5. Make failures debuggable through structured errors and health telemetry.

## 3. Non-Goals

1. Bypassing macOS privacy permissions.
2. High-FPS remote desktop streaming.
3. Cross-platform parity in this phase (macOS first).
4. Fully autonomous destructive actions without confirmation.

## 4. Current Gaps (Codebase-Based)

1. `apps/desktop/skills/screen-capture/src/index.ts` has single-shot capture only, no live sampling session model.
2. `apps/desktop/skills/action-executor/src/index.ts` shells user-derived values directly into scripts; this is reliability and security risk.
3. No unified startup preflight that verifies Screen Recording / Accessibility readiness before task execution.
4. No MCP watchdog/health recovery path when skill processes fail.
5. Prompt rules in `apps/desktop/src/main/opencode/config-generator.ts` do not enforce strong anti-generic behavior when tools fail.
6. Limited structured diagnostics in renderer for why screen/action tools are currently unavailable.

## 5. Functional Spec

### 5.1 Permission And Readiness

1. Add preflight checks for:
   - Screen capture availability.
   - Accessibility input control availability.
2. Expose preflight result to renderer as machine-readable status:
   - `ready`
   - `needs_screen_recording_permission`
   - `needs_accessibility_permission`
   - `mcp_unhealthy`
3. Show explicit fix instructions in UI (path in System Settings).

### 5.2 Screenshot Reliability

1. `capture_screen` must return a structured error code and human message on failure.
2. Capture must support:
   - Full screen.
   - Active window.
   - Optional cursor.
3. Add retries for transient failures (bounded, max 2 retries).

### 5.3 Live Vision (Sampling)

1. Add a new MCP capability for sampled live view:
   - Session start.
   - Pull latest frame.
   - Session stop.
2. Target default sampling rate: 1 fps.
3. Hard cap session duration: 30 seconds (renewable).
4. Use this for "watch what I do" interactions, not persistent background surveillance.

### 5.4 Action Reliability

1. Harden mouse/keyboard execution:
   - Validate and clamp coordinates.
   - Use safe process execution (no raw shell interpolation for untrusted input).
2. Add dry-run validation mode for internal testing.
3. Return structured success/failure codes to the model.

### 5.5 Anti-Repetitive Assistant Behavior

1. If a screenshot/action tool is unavailable, assistant must:
   - State exact blocking dependency once.
   - Provide exact fix path once.
   - Ask one concrete follow-up.
2. Assistant must avoid repeating the same generic line across turns.
3. Add error-context memory for the current session to avoid looped responses.

### 5.6 Safety

1. Non-destructive actions can execute directly.
2. Destructive actions require explicit user confirmation.
3. File permission flow remains mandatory and unchanged.

## 6. Success Metrics

1. Screenshot tool success rate >= 99% in preflight-ready environment.
2. Action command success rate >= 98% for click/type/press_key test suite.
3. Permission-related failures produce actionable message within first response.
4. Repeated generic fallback message rate < 2% of failed tool turns.
5. MCP auto-recovery from process crash within 5 seconds.

## 7. Architecture Additions

1. `desktop-control` main-process module for readiness + diagnostics.
2. `live-screen-stream` MCP skill for sampled live session.
3. Structured tool error schema shared via `packages/shared`.
4. UI diagnostics panel for tool/permission state.
5. MCP supervisor for health and restart.

## 8. Phase-by-Phase Checklist With Acceptance Criteria

Use this as the canonical execution checklist for FEATURE-001.  
Detailed per-agent prompts remain in Section 10.

### Phase 1: Contract Foundation (WP-1)

Checklist:
- [ ] Add shared desktop-control status types in `packages/shared/src/types/desktop-control.ts`.
- [ ] Export new types from `packages/shared/src/types/index.ts`.
- [ ] Keep contracts strict enough to avoid ad-hoc string checks in main/renderer.

Acceptance criteria:
1. `DesktopControlStatus`, `ToolErrorCode`, and `ToolHealthSnapshot` are available via shared exports.
2. No new runtime dependency is introduced for type-only work.
3. `pnpm -F @accomplish/desktop typecheck` passes.

### Phase 2: Preflight Truth + Diagnostics UX (WP-2, WP-3)

Checklist:
- [ ] Implement preflight readiness checks in main process (`screen_capture`, `action_execution`, `mcp_health`).
- [ ] Add IPC endpoint and validation for `desktopControl:getStatus`.
- [ ] Add renderer diagnostics surface with explicit unblock instructions and `Recheck`.
- [ ] Hide diagnostics automatically when readiness returns to `ready`.

Acceptance criteria:
1. IPC returns deterministic machine-readable readiness payloads for blocked/ready states.
2. Blocked states include actionable remediation text (System Settings path).
3. Chat UI shows blockers before tool-dependent actions and updates on `Recheck`.
4. `pnpm -F @accomplish/desktop test:unit` and `pnpm -F @accomplish/desktop test:integration` pass.

### Phase 3: Tool Reliability Hardening (WP-4, WP-6)

Checklist:
- [ ] Harden `screen-capture` with bounded retries and active-window fallback behavior.
- [ ] Harden `action-executor` with strict input validation and safe process execution.
- [ ] Standardize tool failure shape with structured error codes.

Acceptance criteria:
1. Screenshot failures emit deterministic error code + human message format.
2. Mouse/keyboard tools reject invalid input predictably and remain API-compatible.
3. No raw shell interpolation is used for user-provided action arguments.
4. `pnpm -F @accomplish/desktop test` passes.

### Phase 4: Live Vision + Prompt Orchestration (WP-5, WP-8)

Checklist:
- [ ] Add new `live-screen-stream` MCP skill with `start_live_view`, `get_live_frame`, and `stop_live_view`.
- [ ] Enforce 1 fps default sampling and 30-second max session lifetime.
- [ ] Wire the MCP server into generated OpenCode config.
- [ ] Update prompt rules to avoid repetitive fallback loops on tool failures.

Acceptance criteria:
1. Live session lifecycle works end-to-end (start, poll, stop, expiry).
2. Config includes `live-screen-stream` server wiring.
3. Prompt rules explicitly require: name blocker once, provide fix path once, ask one concrete follow-up.
4. `pnpm -F @accomplish/desktop typecheck` and `pnpm -F @accomplish/desktop test:integration` pass.

### Phase 5: Resilience + Test Matrix (WP-7, WP-9)

Checklist:
- [ ] Implement MCP supervisor with per-skill health metadata and restart backoff.
- [ ] Emit health transitions for diagnostics consumers.
- [ ] Add integration + e2e coverage for blocked, recovery, and success paths.

Acceptance criteria:
1. Simulated MCP process failure triggers bounded auto-restart behavior.
2. Health transition events are observable and typed.
3. Tests cover at least one failure and one recovery flow in main, renderer, and e2e layers.
4. `pnpm -F @accomplish/desktop test:unit`, `pnpm -F @accomplish/desktop test:integration`, and `pnpm -F @accomplish/desktop test:e2e:fast` pass.

### Phase 6: Rollout Controls + Operator Readiness (WP-10)

Checklist:
- [ ] Add rollout flags in app settings: `desktopControlPreflight`, `liveScreenSampling`.
- [ ] Publish rollout plan with internal -> beta -> GA gates.
- [ ] Publish support runbook with symptom/cause/remediation guidance.

Acceptance criteria:
1. Flags are backward-compatible and follow existing settings persistence patterns.
2. Rollout document defines promotion and rollback gates for each cohort phase.
3. README includes operator-facing troubleshooting references.
4. `pnpm -F @accomplish/desktop typecheck` passes.

### Feature Exit Gate (All Phases Complete)

Checklist:
- [ ] All phase acceptance criteria above are met.
- [ ] No open blocker bugs tagged for desktop-control reliability rollout.
- [ ] Section 6 success metrics are met in preflight-ready environments.
- [ ] `bugs-and-features.md` reflects current status for all related bugs/features.

Acceptance criteria:
1. Screenshot success rate >= 99% and action success rate >= 98% in validated runs.
2. Permission-related failures provide actionable guidance on first response.
3. Repeated generic fallback rate remains below 2% of failed tool turns.
4. MCP auto-recovery is demonstrated within 5 seconds in failure drills.

## 9. Phase Sequence

Execution order:
1. Phase 1 (WP-1)
2. Phase 2 (WP-2 + WP-3)
3. Phase 3 (WP-4 + WP-6)
4. Phase 4 (WP-5 + WP-8)
5. Phase 5 (WP-7 + WP-9)
6. Phase 6 (WP-10)

## 10. Agent Prompts (Detailed, Copy/Paste)

Use each prompt in a separate agent session.  
All prompts below include: bug context, exact app area, owned files, constraints, and acceptance checks.

### Agent 1 Prompt (WP-1) - Shared Contracts

You are implementing the shared contract layer for desktop-control reliability in `/Users/hareli/Projects/openwork`.

User-reported bug context:
- Assistant cannot reliably say *why* it cannot take screenshot/control inputs.
- Different subsystems return ad-hoc errors, so UI and prompt logic cannot handle failures consistently.

App area you are fixing:
- Shared type contracts consumed by main process, renderer, and MCP integrations.
- This sits below IPC and above skill runtime details.

Owned files (edit only these):
- `/Users/hareli/Projects/openwork/packages/shared/src/types/desktop-control.ts` (create)
- `/Users/hareli/Projects/openwork/packages/shared/src/types/index.ts`

What to implement:
1. Define canonical readiness/status enums and payload types for:
   - overall desktop control readiness
   - per-capability readiness (`screen_capture`, `action_execution`, `mcp_health`)
2. Define structured tool error codes (permission denied, timeout, unavailable binary, validation error, unknown).
3. Define health snapshot contract with timestamps and per-skill state.
4. Export all new types through `index.ts`.

Hard constraints:
- Do not modify any app logic files.
- Do not add runtime dependencies.

Acceptance criteria:
- Types are strict and reusable from both `@main/*` and `@renderer/*`.
- Naming is explicit enough to avoid stringly-typed status checks in downstream code.

Validation command:
- `pnpm -F @accomplish/desktop typecheck`

Return format:
- Short summary
- Exact changed file list
- Any follow-up type gaps discovered

### Agent 2 Prompt (WP-2) - Main Process Preflight + IPC

You are implementing preflight readiness checks in `/Users/hareli/Projects/openwork`.

User-reported bug context:
- Assistant says it cannot see screen/click/type, but user gets no deterministic reason/fix path.
- We need main-process truth for readiness before task execution.

App flow location:
- Renderer (`FloatingChat`) calls preload API.
- Preload invokes IPC handlers in main process.
- Main process returns structured readiness for UI + agent behavior.

Owned files (edit only these):
- `/Users/hareli/Projects/openwork/apps/desktop/src/main/desktop-control/preflight.ts` (create)
- `/Users/hareli/Projects/openwork/apps/desktop/src/main/ipc/handlers.ts`
- `/Users/hareli/Projects/openwork/apps/desktop/src/main/ipc/validation.ts`

What to implement:
1. Add preflight service that checks:
   - screen capture capability availability
   - accessibility/action capability availability
   - MCP process health signal (stub/placeholder allowed but typed)
2. Add IPC handler: `desktopControl:getStatus`.
3. Add validation schema for response shape.
4. Cache result for 5 seconds to avoid spamming expensive checks.
5. Include user-facing remediation text in response (System Settings path).

Hard constraints:
- Do not touch renderer or skill source files.
- Keep current task start/cancel flow unchanged.

Acceptance criteria:
- IPC returns deterministic machine-readable states.
- Failures are mapped to explicit error codes (not free-form text only).
- Handler fails safely and returns `mcp_unhealthy`/`unknown` states rather than crashing.

Validation command:
- `pnpm -F @accomplish/desktop test:unit`

Return format:
- Summary
- Changed files
- Example response JSON for each status

### Agent 3 Prompt (WP-3) - Renderer Diagnostics UX

You are implementing diagnostics UX for desktop-control readiness in `/Users/hareli/Projects/openwork`.

User-reported bug context:
- User experiences repeated generic AI answers because UI doesn’t expose concrete blockers early.
- Need immediate visual explanation and “what to do next.”

App flow location:
- Chat UI is `/Users/hareli/Projects/openwork/apps/desktop/src/renderer/components/FloatingChat.tsx`.
- Renderer API bridge is `/Users/hareli/Projects/openwork/apps/desktop/src/renderer/lib/accomplish.ts`.
- New diagnostics component should mount near chat input/actions.

Owned files (edit only these):
- `/Users/hareli/Projects/openwork/apps/desktop/src/renderer/components/desktop-control/DiagnosticsPanel.tsx` (create)
- `/Users/hareli/Projects/openwork/apps/desktop/src/renderer/components/FloatingChat.tsx`
- `/Users/hareli/Projects/openwork/apps/desktop/src/renderer/lib/accomplish.ts`

What to implement:
1. Add renderer API method for `desktopControl:getStatus`.
2. Build `DiagnosticsPanel` that shows:
   - current status
   - exact unblock instructions
   - “Recheck” button
3. In `FloatingChat`, query status on mount and before screenshot/action quick paths.
4. Hide diagnostics automatically when status becomes `ready`.

Hard constraints:
- Do not modify main process or MCP skill code.
- Keep current chat UX behavior intact when `ready`.

Acceptance criteria:
- If status is blocked, user sees explicit reason before sending tool-dependent requests.
- Recheck button triggers fresh IPC call and updates UI state.

Validation command:
- `pnpm -F @accomplish/desktop test:integration`

Return format:
- Summary
- Changed files
- Screenshot or text description of UI states rendered

### Agent 4 Prompt (WP-4) - Screen Capture Skill Hardening

You are hardening screenshot reliability in `/Users/hareli/Projects/openwork`.

User-reported bug context:
- “AI can’t take screenshots” intermittently.
- Need deterministic retry/fallback and structured errors for model and UI.

App flow location:
- MCP skill file: `/Users/hareli/Projects/openwork/apps/desktop/skills/screen-capture/src/index.ts`
- Tool outputs flow through OpenCode stream parser into renderer.

Owned files (edit only this):
- `/Users/hareli/Projects/openwork/apps/desktop/skills/screen-capture/src/index.ts`

What to implement:
1. Add bounded retry policy for transient capture failures.
2. Improve active-window capture fallback to full-screen when window lookup fails.
3. Standardize error responses as `ERR_CODE|human-readable message`.
4. Preserve existing tool names and schemas unless absolutely necessary.

Hard constraints:
- No edits outside this single file.
- No behavioral regressions for successful `capture_screen`.

Acceptance criteria:
- Known failure modes return deterministic error codes.
- Transient failures recover without user intervention when possible.

Validation command:
- `pnpm -F @accomplish/desktop test`

Return format:
- Summary
- Changed file
- List of added error codes + when each is emitted

### Agent 5 Prompt (WP-5) - Live Screen Stream MCP Skill

You are adding sampled live-vision capability in `/Users/hareli/Projects/openwork`.

User-reported bug context:
- User expects “live screen” understanding, not one static screenshot.
- We need controlled sampling, not continuous high-FPS streaming.

App area you are fixing:
- New MCP skill package only. No wiring to main config in this task.

Owned files (create/edit only these):
- `/Users/hareli/Projects/openwork/apps/desktop/skills/live-screen-stream/package.json`
- `/Users/hareli/Projects/openwork/apps/desktop/skills/live-screen-stream/tsconfig.json`
- `/Users/hareli/Projects/openwork/apps/desktop/skills/live-screen-stream/src/index.ts`

What to implement:
1. MCP server with tools:
   - `start_live_view`
   - `get_live_frame`
   - `stop_live_view`
2. Session model:
   - default sampling interval 1000ms (1 fps)
   - max session lifetime 30s
   - explicit stop and cleanup
3. Return frame as image content payload consistent with existing screenshot patterns.
4. Include error codes for invalid session, expired session, capture failure.

Hard constraints:
- Do not modify config generator, existing skills, or renderer/main wiring.
- Keep implementation stateless across process restarts (in-memory only).

Acceptance criteria:
- Can start session, pull frames, and stop cleanly.
- Session auto-expires at 30s with clear error code.

Validation command:
- `pnpm -F @accomplish/desktop typecheck`

Return format:
- Summary
- Changed files
- Tool schema summary (inputs/outputs)

### Agent 6 Prompt (WP-6) - Action Executor Hardening

You are hardening mouse/keyboard execution in `/Users/hareli/Projects/openwork`.

User-reported bug context:
- “AI can’t move mouse/type/press keys” plus inconsistent failures.
- Existing implementation also has injection-risky command composition.

App flow location:
- MCP action skill used by screen-agent for click/type/keys:
  `/Users/hareli/Projects/openwork/apps/desktop/skills/action-executor/src/index.ts`

Owned files (edit only this):
- `/Users/hareli/Projects/openwork/apps/desktop/skills/action-executor/src/index.ts`

What to implement:
1. Strict input validation:
   - numeric finite coordinates
   - sensible coordinate bounds/clamping
   - supported key/modifier validation
2. Replace risky command interpolation with safer execution patterns.
3. Emit structured error codes (permission missing, invalid input, execution failed).
4. Keep existing tool names/API compatible.

Hard constraints:
- No edits outside this file.
- Do not remove current tools.

Acceptance criteria:
- Invalid input is rejected predictably.
- Normal click/type/key flows remain functional.
- Error messaging helps upper layers explain the fix.

Validation command:
- `pnpm -F @accomplish/desktop test`

Return format:
- Summary
- Changed file
- Before/after note for risky execution path

### Agent 7 Prompt (WP-7) - MCP Supervisor + Recovery

You are implementing MCP health supervision in `/Users/hareli/Projects/openwork`.

User-reported bug context:
- If tool subprocesses die, assistant silently degrades into generic responses.
- Need auto-recovery and health visibility.

App flow location:
- Task orchestration is in:
  - `/Users/hareli/Projects/openwork/apps/desktop/src/main/opencode/task-manager.ts`
- Add supervisor module:
  - `/Users/hareli/Projects/openwork/apps/desktop/src/main/opencode/mcp-supervisor.ts` (new)

Owned files (edit only these):
- `/Users/hareli/Projects/openwork/apps/desktop/src/main/opencode/mcp-supervisor.ts` (create)
- `/Users/hareli/Projects/openwork/apps/desktop/src/main/opencode/task-manager.ts`

What to implement:
1. Track per-skill health metadata (last seen, status, restart attempts).
2. Restart unhealthy MCP processes with bounded exponential backoff.
3. Emit health events for renderer/main diagnostics consumers.
4. Ensure cleanup on task stop/cancel/app exit.

Hard constraints:
- Do not modify config generator, renderer, or skill source files.
- Avoid changing task semantics (queued/running lifecycle).

Acceptance criteria:
- Simulated MCP failure triggers restart path.
- Health state transitions are observable and typed.

Validation command:
- `pnpm -F @accomplish/desktop test:unit`

Return format:
- Summary
- Changed files
- State machine or transition table for health states

### Agent 8 Prompt (WP-8) - Prompt Rules + MCP Wiring

You are improving agent behavior and wiring live stream MCP in `/Users/hareli/Projects/openwork`.

User-reported bug context:
- Assistant repeats generic responses when tools fail.
- Need strict instruction policy + live-view capability references.

App flow location:
- OpenCode config and screen-agent system prompt:
  `/Users/hareli/Projects/openwork/apps/desktop/src/main/opencode/config-generator.ts`

Owned files (edit only this):
- `/Users/hareli/Projects/openwork/apps/desktop/src/main/opencode/config-generator.ts`

What to implement:
1. Add `live-screen-stream` MCP server entry in generated config.
2. Update system prompt rules so on tool failure agent must:
   - name blocker once
   - provide specific fix path
   - ask one concrete follow-up
3. Add explicit live-view workflow guidance (start/poll/stop session model).
4. Keep existing file permission workflow instructions intact.

Hard constraints:
- Do not edit any other file.
- Preserve current provider/model logic.

Acceptance criteria:
- Generated config includes new MCP server.
- Prompt includes anti-loop behavior constraints for failed tool turns.

Validation command:
- `pnpm -F @accomplish/desktop test:integration`

Return format:
- Summary
- Changed file
- Snippet of resulting MCP config block and new prompt section

### Agent 9 Prompt (WP-9) - Integration + E2E Test Matrix

You are writing test coverage for desktop-control reliability in `/Users/hareli/Projects/openwork`.

User-reported bug context:
- Regressions in screenshot/action readiness are not caught automatically.
- Need confidence for permission-denied and recovery flows.

App area you are fixing:
- Integration tests for main + renderer behavior.
- E2E test for user-visible desktop control flow.

Owned files (create/edit only these):
- `/Users/hareli/Projects/openwork/apps/desktop/__tests__/integration/main/desktop-control.preflight.integration.test.ts`
- `/Users/hareli/Projects/openwork/apps/desktop/__tests__/integration/renderer/components/DiagnosticsPanel.integration.test.tsx`
- `/Users/hareli/Projects/openwork/apps/desktop/e2e/specs/desktop-control.spec.ts`

What to implement:
1. Main integration tests for preflight statuses and structured payloads.
2. Renderer integration tests for diagnostics visibility/recheck/hide-on-ready.
3. E2E scenario covering:
   - blocked permission state
   - user remediation
   - successful follow-up action/screenshot path

Hard constraints:
- Do not edit production source files.
- Avoid brittle selectors; use stable identifiers.

Acceptance criteria:
- Tests fail before feature behavior exists and pass after implementation.
- Coverage includes at least one failure + one recovery path per layer.

Validation commands:
- `pnpm -F @accomplish/desktop test:integration`
- `pnpm -F @accomplish/desktop test:e2e:fast`

Return format:
- Summary
- Changed files
- Any flaky-test risks discovered

### Agent 10 Prompt (WP-10) - Flags, Rollout, Runbook

You are implementing rollout controls and operator docs in `/Users/hareli/Projects/openwork`.

User-reported bug context:
- Feature needs safe staged rollout; failure handling must be operable by support/dev teams.

App area you are fixing:
- Persistent app settings flags for feature gating.
- Documentation for staged release and troubleshooting.

Owned files (edit only these):
- `/Users/hareli/Projects/openwork/apps/desktop/src/main/store/appSettings.ts`
- `/Users/hareli/Projects/openwork/docs/plans/2026-02-13-desktop-control-rollout.md` (create)
- `/Users/hareli/Projects/openwork/README.md`

What to implement:
1. Add settings flags:
   - `desktopControlPreflight`
   - `liveScreenSampling`
2. Ensure defaults are safe for phased rollout.
3. Add rollout document with phases:
   - internal
   - beta
   - GA
4. Add troubleshooting runbook:
   - symptom
   - probable cause
   - remediation steps

Hard constraints:
- Do not edit MCP skill code or task-manager internals.
- Keep existing settings backward compatible.

Acceptance criteria:
- Flags are readable/writable through existing settings pattern.
- Docs are actionable for support and engineering.

Validation command:
- `pnpm -F @accomplish/desktop typecheck`

Return format:
- Summary
- Changed files
- Rollout checklist table
