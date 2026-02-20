import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DesktopControlCapabilityReadiness,
  DesktopControlReadinessCapability,
  DesktopControlReadinessSnapshot,
} from './readiness';

const evaluateDesktopControlReadinessMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    isReady: () => true,
  },
}));

vi.mock('./readiness', () => ({
  evaluateDesktopControlReadiness: evaluateDesktopControlReadinessMock,
}));

import { getDesktopControlStatus } from './preflight';

const CHECKED_AT = '2026-02-19T01:00:00.000Z';

function buildCapabilityReadiness(
  capability: DesktopControlReadinessCapability,
  overrides: Partial<DesktopControlCapabilityReadiness> = {}
): DesktopControlCapabilityReadiness {
  const reasonCodeByCapability: Record<DesktopControlReadinessCapability, string> = {
    screen_capture: 'screen_capture_ok',
    action_execution: 'action_execution_ok',
    mcp_health: 'runtime_health_ok',
  };
  const messageByCapability: Record<DesktopControlReadinessCapability, string> = {
    screen_capture: 'Screen recording permission is granted.',
    action_execution: 'Accessibility permission is granted.',
    mcp_health: 'Desktop control runtime dependencies are present.',
  };

  return {
    capability,
    state: 'ok',
    reasonCode: reasonCodeByCapability[capability],
    message: messageByCapability[capability],
    checkedAt: CHECKED_AT,
    attempts: [{ attempt: 1, durationMs: 2, outcome: 'ok', reasonCode: reasonCodeByCapability[capability] }],
    retryPolicy: { timeoutMs: 100, maxAttempts: 2 },
    ...overrides,
  };
}

function buildReadinessSnapshot(
  overrides: Partial<Record<DesktopControlReadinessCapability, Partial<DesktopControlCapabilityReadiness>>> = {}
): DesktopControlReadinessSnapshot {
  return {
    checkedAt: CHECKED_AT,
    checks: {
      screen_capture: buildCapabilityReadiness('screen_capture', overrides.screen_capture),
      action_execution: buildCapabilityReadiness('action_execution', overrides.action_execution),
      mcp_health: buildCapabilityReadiness('mcp_health', overrides.mcp_health),
    },
  };
}

describe('desktop-control preflight diagnostics mapping', () => {
  beforeEach(() => {
    evaluateDesktopControlReadinessMock.mockReset();
  });

  it('maps denied screen recording permission to an explicit permission status and code', async () => {
    evaluateDesktopControlReadinessMock.mockResolvedValue(
      buildReadinessSnapshot({
        screen_capture: {
          state: 'unavailable',
          reasonCode: 'screen_capture_permission_denied',
          message: 'Screen recording permission is denied.',
        },
      })
    );

    const status = await getDesktopControlStatus({ forceRefresh: true });

    expect(status.status).toBe('needs_screen_recording_permission');
    expect(status.errorCode).toBe('screen_recording_permission_denied');
    expect(status.message).toBe('Screen recording permission is denied.');
    expect(status.remediation.title).toBe('Allow Screen Recording');
    expect(status.checks.screen_capture.errorCode).toBe('screen_recording_permission_denied');
  });

  it('maps restricted screen recording permission to policy-specific remediation', async () => {
    evaluateDesktopControlReadinessMock.mockResolvedValue(
      buildReadinessSnapshot({
        screen_capture: {
          state: 'unavailable',
          reasonCode: 'screen_capture_permission_restricted',
          message: 'Screen recording permission is restricted by system policy.',
        },
      })
    );

    const status = await getDesktopControlStatus({ forceRefresh: true });

    expect(status.status).toBe('needs_screen_recording_permission');
    expect(status.errorCode).toBe('screen_recording_permission_restricted');
    expect(status.remediation.title).toBe('Screen Recording restricted by policy');
    expect(status.remediation.steps.some((step) => step.includes('administrator'))).toBe(true);
  });

  it('keeps timeout-based unknown states actionable instead of collapsing to generic unknown', async () => {
    evaluateDesktopControlReadinessMock.mockResolvedValue(
      buildReadinessSnapshot({
        screen_capture: {
          state: 'degraded',
          reasonCode: 'screen_capture_probe_timeout',
          message: 'Screen capture readiness check timed out.',
        },
      })
    );

    const status = await getDesktopControlStatus({ forceRefresh: true });

    expect(status.status).toBe('unknown');
    expect(status.errorCode).toBe('screen_recording_status_unknown');
    expect(status.message).toBe('Screen recording readiness check timed out.');
    expect(status.remediation.title).toBe('Retry readiness check');
  });

  it('maps denied accessibility permission to an explicit permission status and code', async () => {
    evaluateDesktopControlReadinessMock.mockResolvedValue(
      buildReadinessSnapshot({
        action_execution: {
          state: 'unavailable',
          reasonCode: 'action_execution_permission_denied',
          message: 'Accessibility permission is required before desktop actions can run.',
        },
      })
    );

    const status = await getDesktopControlStatus({ forceRefresh: true });

    expect(status.status).toBe('needs_accessibility_permission');
    expect(status.errorCode).toBe('accessibility_permission_denied');
    expect(status.message).toBe('Accessibility permission is required before desktop actions can run.');
  });
});
