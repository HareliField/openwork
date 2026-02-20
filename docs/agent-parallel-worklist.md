# Agent Parallel Worklist (Missions, Bugs, Problems, Features)

Purpose: give multiple agents a single, clear list of work that can run in parallel with minimal overlap.

Rules for parallel execution:
- Each area has separate file ownership to reduce merge conflicts.
- Pick items in numeric order.
- One item = one PR.
- Do not edit files owned by another area unless the task explicitly says so.

## Area 1 - Security Hardening (Agent A)
Owned paths:
- `apps/desktop/skills/action-executor/**`
- `apps/desktop/src/main/permission-api.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/main/ipc/**`

1. Fix command injection risk in `action-executor` skill (BUG-015).
2. Restrict CORS origins in permission API (BUG-016).
3. Stop returning full API keys to renderer and add masking flow (BUG-018).
4. Add security regression tests for the above fixes.

## Area 2 - Desktop Control Reliability (Agent B)
Owned paths:
- `apps/desktop/src/main/desktop-control/**`
- `apps/desktop/src/main/agents/screen-agent/**`
- `apps/desktop/src/renderer/components/desktop-control/**`
- `tests/desktop-control/**`

5. Implement `FEATURE-001` reliability milestones from `docs/plans/2026-02-13-desktop-control-reliability-plan.md`.
6. Improve diagnostics for permission and readiness failure states.
7. Add end-to-end tests for screenshot + action reliability.
8. Reduce repetitive fallback responses in screen-agent flows.
29. Fix Screen Agent visibility/action failures by hardening Screen Recording + Accessibility permission detection, recheck triggers, and recovery behavior.
30. Resolve persistent "Desktop Control Diagnostics" blocked state on app startup and ensure UI/runtime status clears automatically after recovery.

## Area 3 - Task/Streaming Engine Stability (Agent C)
Owned paths:
- `apps/desktop/src/main/opencode/**`
- `apps/desktop/src/renderer/components/FloatingChat.tsx`
- `apps/desktop/src/renderer/components/ui/streaming-text.tsx`

9. Handle signal-killed process completion in adapter (BUG-011).
10. Refactor smart trigger subscription lifecycle to avoid missed events (BUG-014).
11. Audit stream finalization paths and add tests for partial-line process exits.
12. Add telemetry hooks for task cancel/start race conditions.

## Area 4 - Packaging and Runtime Environment (Agent D)
Owned paths:
- `apps/desktop/scripts/**`
- `apps/desktop/run_*.sh`
- `apps/desktop/src/main/utils/**`

13. Validate post-pack binary placement on macOS/Windows/Linux.
14. Add CI checks for packaged app path assumptions.
15. Verify PATH/bootstrap behavior in runtime config generation.
16. Document packaging verification checklist in `docs/`.

## Area 5 - UX and Settings Quality (Agent E)
Owned paths:
- `apps/desktop/src/renderer/components/layout/**`
- `apps/desktop/src/renderer/components/ui/**`
- `apps/desktop/__tests__/integration/renderer/**`

17. Strengthen provider/API-key validation flows (BUG-013 follow-up).
18. Improve settings state reset and user feedback consistency.
19. Add UX tests for dialog open/close and validation edge cases.
20. Standardize loading/error/success messaging patterns.

## Area 6 - Docs, Planning, and Tracking (Agent F)
Owned paths:
- `docs/plans/**`
- `bugs-and-features.md`
- `README.md`

21. Keep `bugs-and-features.md` current with real status (fixed/planned/not fixing).
22. Convert `FEATURE-001` plan into phase-by-phase checklist with acceptance criteria.
23. Add contributor guide section for parallel multi-agent workflow.
24. Publish weekly progress summary template for all areas.

## Area 7 - Computer Health and Diagnostics (Agent G)
Owned paths:
- `scripts/desktop-control-healthcheck/**`
- `tests/desktop-control/**`
- `docs/plans/**`

25. Expand startup healthcheck to validate required permissions and local dependencies.
26. Add machine-readiness report output (pass/fail per check, clear remediation hints).
27. Add CI/local command to run all diagnostics in one step.
28. Document "healthy machine baseline" for agents before starting tasks.

## Intake: New Mission/Bug/Problem/Feature Format
Use this template when adding new items:

- ID: `AREA-###`
- Type: Mission | Bug | Problem | Feature
- Severity: Critical | High | Medium | Low
- Area owner: A/B/C/D/E/F/G
- Files: exact paths
- Repro steps (if bug/problem):
- Expected result:
- Actual result:
- Proposed fix:
- Tests required:
- Status: TODO | IN PROGRESS | BLOCKED | DONE
