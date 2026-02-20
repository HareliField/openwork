import { describe, expect, it } from 'vitest';
import type { DesktopControlStatusPayload } from '../../../../src/renderer/lib/accomplish';
import {
  buildDesktopControlBlockedMessage,
  createDesktopControlBlockerKey,
  getDesktopControlBlockedCapabilities,
  shouldEmitDesktopControlFallback,
  type DesktopControlRequirement,
} from '../../../../src/renderer/components/desktop-control/fallbackGuard';

const REQUIREMENT: DesktopControlRequirement = {
  blockedAction: 'screenshots',
  capabilities: ['screen_capture', 'mcp_health'],
};

function buildDetailedStatus(
  overrides: Partial<DesktopControlStatusPayload> = {}
): DesktopControlStatusPayload {
  const baseStatus: DesktopControlStatusPayload = {
    status: 'needs_screen_recording_permission',
    errorCode: 'screen_recording_permission_required',
    message: 'Screen recording permission is required before taking screenshots.',
    remediation: {
      title: 'Allow Screen Recording',
      steps: ['Open System Settings > Privacy & Security > Screen Recording.'],
      systemSettingsPath: 'System Settings > Privacy & Security > Screen Recording',
    },
    checkedAt: '2026-02-14T01:00:00.000Z',
    cache: {
      ttlMs: 5000,
      expiresAt: '2026-02-14T01:00:05.000Z',
      fromCache: false,
    },
    checks: {
      screen_capture: {
        capability: 'screen_capture',
        status: 'blocked',
        errorCode: 'screen_recording_permission_required',
        message: 'Screen recording permission is required before taking screenshots.',
        remediation: {
          title: 'Allow Screen Recording',
          steps: ['Open System Settings > Privacy & Security > Screen Recording.'],
          systemSettingsPath: 'System Settings > Privacy & Security > Screen Recording',
        },
        checkedAt: '2026-02-14T01:00:00.000Z',
      },
      action_execution: {
        capability: 'action_execution',
        status: 'ready',
        errorCode: null,
        message: 'Accessibility permission is granted.',
        remediation: {
          title: 'No action needed',
          steps: ['Desktop control dependencies are ready.'],
        },
        checkedAt: '2026-02-14T01:00:00.000Z',
      },
      mcp_health: {
        capability: 'mcp_health',
        status: 'ready',
        errorCode: null,
        message: 'MCP runtime dependencies are present.',
        remediation: {
          title: 'No action needed',
          steps: ['Desktop control dependencies are ready.'],
        },
        checkedAt: '2026-02-14T01:00:00.000Z',
      },
    },
  };

  return {
    ...baseStatus,
    ...overrides,
  };
}

describe('fallbackGuard', () => {
  it('returns only required blocked capabilities', () => {
    const blocked = getDesktopControlBlockedCapabilities(buildDetailedStatus(), REQUIREMENT);
    expect(blocked).toEqual(['screen_capture']);
  });

  it('builds blocker key from capability and error details', () => {
    const blockedStatus = buildDetailedStatus();
    const blockedKey = createDesktopControlBlockerKey(blockedStatus, REQUIREMENT);
    const readyStatus: DesktopControlStatusPayload = {
      ...blockedStatus,
      status: 'ready',
      errorCode: null,
      checks: {
        ...blockedStatus.checks,
        screen_capture: {
          ...blockedStatus.checks.screen_capture,
          status: 'ready',
          errorCode: null,
        },
      },
    };
    const readyKey = createDesktopControlBlockerKey(readyStatus, REQUIREMENT);

    expect(blockedKey).not.toBe(readyKey);
  });

  it('builds a specific blocked message with settings path', () => {
    const message = buildDesktopControlBlockedMessage(buildDetailedStatus(), REQUIREMENT);
    expect(message).toContain('I cannot run screenshots yet');
    expect(message).toContain('screen capture is blocked');
    expect(message).toContain('screen_recording_permission_required');
    expect(message).toContain('System Settings > Privacy & Security > Screen Recording');
  });

  it('suppresses repeated fallback for unchanged blocker keys', () => {
    const key = createDesktopControlBlockerKey(buildDetailedStatus(), REQUIREMENT);

    expect(shouldEmitDesktopControlFallback(null, key)).toBe(true);
    expect(shouldEmitDesktopControlFallback(key, key)).toBe(false);
  });
});
