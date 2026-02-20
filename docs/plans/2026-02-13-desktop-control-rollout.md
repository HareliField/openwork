# Desktop Control Rollout And Support Runbook

Date: 2026-02-13  
Status: Proposed  
Owners: WP-10 (Flags + Rollout + Runbook)

## 1. Feature Flags

The desktop app uses two app-setting flags to gate rollout:

1. `desktopControlPreflight`
2. `liveScreenSampling`

Default values in `apps/desktop/src/main/store/appSettings.ts`:

- `desktopControlPreflight: false`
- `liveScreenSampling: false`

These defaults keep both capabilities opt-in until each phase gate is passed.

## 2. Rollout Phases

### Phase 1: Internal

Audience:
- Engineering + support dogfood cohort only.

Target exposure:
- 100% of internal installs.
- 0% external users.

Flags:
- `desktopControlPreflight: true`
- `liveScreenSampling: false` for first 24 hours, then `true` for internal cohort after stability check.

Entry gate:
- Build passes `pnpm -F @accomplish/desktop typecheck`.
- Support runbook reviewed by support lead.

Promotion gate to Beta:
- 2 business days with no P0/P1 incidents.
- Screenshot/action flows pass manual verification on at least 3 macOS machines.
- No unresolved permission false-positive bugs in triage.

Rollback conditions:
- Any P0/P1 crash or data-loss issue linked to preflight/live sampling.
- More than 10% of internal sessions blocked by incorrect preflight status.

Rollback action:
- Set `liveScreenSampling` to `false` for all internal users first.
- If impact persists, set `desktopControlPreflight` to `false` and release hotfix.

### Phase 2: Beta

Audience:
- Opted-in beta users.

Target exposure:
- Start 10% of beta cohort, then 50% after 3 stable days.

Flags:
- `desktopControlPreflight: true`
- `liveScreenSampling: true` only for the 10% beta canary slice during first step.

Entry gate:
- Internal phase promotion gate passed.
- Support on-call prepared with this runbook.

Promotion gate to GA:
- 7 consecutive days without Sev-1 incidents.
- Desktop-control related support ticket rate below 3% of beta weekly active users.
- No open blocker bugs tagged `desktop-control-rollout`.

Rollback conditions:
- Sev-1 incident in beta.
- Support ticket rate above 5% for 24 hours.
- Reproducible CPU regression from live sampling on supported macOS versions.

Rollback action:
- Disable `liveScreenSampling` for beta immediately.
- If unresolved within 4 hours, disable `desktopControlPreflight` for beta and pause promotion.

### Phase 3: GA

Audience:
- All users.

Target exposure:
- 25% -> 50% -> 100% over 3 release windows.

Flags:
- `desktopControlPreflight: true`
- `liveScreenSampling: true` once 50% GA gate passes.

Entry gate:
- Beta promotion gate passed.
- Release notes include known limitations and permission requirements.

Steady-state gate:
- Maintain desktop-control success metrics from reliability plan.
- Weekly support review confirms no new trend in permission or sampling regressions.

Rollback conditions:
- Any Sev-1 production incident.
- 3-day moving average of desktop-control failures increases by 2x baseline.

Rollback action:
- Disable `liveScreenSampling` globally.
- If failure trend continues, disable `desktopControlPreflight` globally and revert to previous stable release.

## 3. Rollout Operations Checklist

Baseline prerequisite for operators and contributors:
- Complete the machine baseline in `docs/plans/2026-02-19-desktop-control-healthy-machine-baseline.md` before phase execution or troubleshooting.

1. Confirm both flags and defaults are present in `apps/desktop/src/main/store/appSettings.ts`.
2. Confirm `pnpm -F @accomplish/desktop typecheck` is green for release candidate.
3. Announce phase start in engineering + support channels with:
   - Enabled flags
   - Cohort size
   - Rollback owner
4. Monitor first 2 hours after each cohort increase for crash, permission, and latency reports.
5. If rollback trigger is hit, execute rollback action immediately and post incident update.

## 4. Support Troubleshooting Runbook

| Symptom | Probable cause | Remediation steps |
|---|---|---|
| User cannot start desktop control; app says permissions are required | `desktopControlPreflight` is enabled and macOS permissions are missing | 1) In macOS, open System Settings -> Privacy & Security. 2) Enable Openwork under Screen Recording and Accessibility. 3) Fully quit and relaunch Openwork. 4) Retry action. |
| User asks for live screen watching and assistant says feature is unavailable | `liveScreenSampling` is disabled for this cohort | 1) Confirm user is in rollout cohort. 2) If approved, enable `liveScreenSampling` for that cohort. 3) Restart app and re-test. |
| User reports high CPU/fan usage after enabling live workflows | Live sampling enabled on a constrained machine or too many repeated sampling sessions | 1) Disable `liveScreenSampling` for affected user/cohort. 2) Ask user to relaunch app. 3) Capture logs and machine details for engineering follow-up. |
| Assistant repeatedly gives generic fallback replies after tool failures | Preflight disabled or MCP dependencies unhealthy, so user gets poor fallback loop behavior | 1) Verify `desktopControlPreflight` is enabled for cohort. 2) Relaunch app to recover MCP processes. 3) Retry with a simple screenshot request. 4) Escalate with logs if still failing. |
| Rollout cohort sees sudden spike in failures after new phase step | Cohort expansion happened before stability criteria were met | 1) Stop further rollout immediately. 2) Roll back `liveScreenSampling` first. 3) If failures continue, roll back `desktopControlPreflight`. 4) Open incident and attach failure samples. |

## 5. Escalation And Ownership

1. Support owns first-response triage using the runbook table above.
2. Engineering on-call owns flag rollback decisions and hotfixes.
3. Product owner approves phase promotions after gate review.
