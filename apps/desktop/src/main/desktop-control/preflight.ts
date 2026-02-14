import { app } from 'electron';
import {
  evaluateDesktopControlReadiness,
  type DesktopControlCapabilityReadiness,
} from './readiness';

export const PREFLIGHT_CACHE_TTL_MS = 5000;

type DesktopControlOverallStatus =
  | 'ready'
  | 'needs_screen_recording_permission'
  | 'needs_accessibility_permission'
  | 'mcp_unhealthy'
  | 'unknown';

type DesktopControlCapability = 'screen_capture' | 'action_execution' | 'mcp_health';
type DesktopControlCheckStatus = 'ready' | 'blocked' | 'unknown';

interface DesktopControlRemediation {
  title: string;
  steps: string[];
  systemSettingsPath?: string;
}

interface DesktopControlCapabilityStatus {
  capability: DesktopControlCapability;
  status: DesktopControlCheckStatus;
  errorCode: string | null;
  message: string;
  remediation: DesktopControlRemediation;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export interface DesktopControlStatusSnapshot {
  status: DesktopControlOverallStatus;
  errorCode: string | null;
  message: string;
  remediation: DesktopControlRemediation;
  checkedAt: string;
  cache: {
    ttlMs: number;
    expiresAt: string;
    fromCache: boolean;
  };
  checks: {
    screen_capture: DesktopControlCapabilityStatus;
    action_execution: DesktopControlCapabilityStatus;
    mcp_health: DesktopControlCapabilityStatus;
  };
}

type SnapshotWithoutCache = Omit<DesktopControlStatusSnapshot, 'cache'>;

const ERROR_CODES = {
  SCREEN_RECORDING_PERMISSION_REQUIRED: 'screen_recording_permission_required',
  SCREEN_RECORDING_STATUS_UNKNOWN: 'screen_recording_status_unknown',
  ACCESSIBILITY_PERMISSION_REQUIRED: 'accessibility_permission_required',
  ACCESSIBILITY_STATUS_UNKNOWN: 'accessibility_status_unknown',
  MCP_HEALTHCHECK_FAILED: 'mcp_healthcheck_failed',
  MCP_HEALTH_UNKNOWN: 'mcp_health_unknown',
  PLATFORM_UNSUPPORTED: 'platform_unsupported',
  PREFLIGHT_UNKNOWN: 'desktop_control_preflight_unknown',
} as const;

const SCREEN_RECORDING_PERMISSION_REASONS = new Set([
  'screen_capture_permission_denied',
  'screen_capture_permission_restricted',
  'screen_capture_permission_not_determined',
]);

const ACCESSIBILITY_PERMISSION_REASONS = new Set(['action_execution_permission_denied']);

let cachedSnapshot: {
  expiresAtMs: number;
  value: SnapshotWithoutCache;
} | null = null;

function readyRemediation(title = 'No action needed'): DesktopControlRemediation {
  return {
    title,
    steps: ['Desktop control dependencies are ready.'],
  };
}

function screenRecordingRemediation(): DesktopControlRemediation {
  return {
    title: 'Allow Screen Recording',
    systemSettingsPath: 'System Settings > Privacy & Security > Screen Recording',
    steps: [
      'Open System Settings > Privacy & Security > Screen Recording.',
      'Enable permission for Screen Agent.',
      'Quit and reopen Screen Agent, then recheck status.',
    ],
  };
}

function accessibilityRemediation(): DesktopControlRemediation {
  return {
    title: 'Allow Accessibility',
    systemSettingsPath: 'System Settings > Privacy & Security > Accessibility',
    steps: [
      'Open System Settings > Privacy & Security > Accessibility.',
      'Enable permission for Screen Agent.',
      'Quit and reopen Screen Agent, then recheck status.',
    ],
  };
}

function mcpRemediation(): DesktopControlRemediation {
  return {
    title: 'Repair desktop control runtime',
    steps: [
      'Restart Screen Agent.',
      'If the issue persists, reinstall or re-sync the app resources/skills bundle.',
      'Run status check again after restart.',
    ],
  };
}

function unknownRemediation(): DesktopControlRemediation {
  return {
    title: 'Retry readiness check',
    steps: [
      'Restart Screen Agent and run the status check again.',
      'If this keeps failing, collect logs and reinstall the app.',
    ],
  };
}

function createCapabilityStatus(
  capability: DesktopControlCapability,
  status: DesktopControlCheckStatus,
  checkedAt: string,
  message: string,
  remediation: DesktopControlRemediation,
  errorCode: string | null = null,
  details?: Record<string, unknown>
): DesktopControlCapabilityStatus {
  return {
    capability,
    status,
    errorCode,
    message,
    remediation,
    checkedAt,
    details,
  };
}

function readinessDetails(
  readiness: DesktopControlCapabilityReadiness,
  details: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    readinessState: readiness.state,
    readinessReasonCode: readiness.reasonCode,
    attempts: readiness.attempts,
    retryPolicy: readiness.retryPolicy,
    ...(readiness.details ?? {}),
    ...details,
  };
}

function getScreenCaptureStatus(
  checkedAt: string,
  readiness: DesktopControlCapabilityReadiness
): DesktopControlCapabilityStatus {
  if (readiness.state === 'ok') {
    return createCapabilityStatus(
      'screen_capture',
      'ready',
      checkedAt,
      'Screen recording permission is granted.',
      readyRemediation(),
      null,
      readinessDetails(readiness)
    );
  }

  if (SCREEN_RECORDING_PERMISSION_REASONS.has(readiness.reasonCode)) {
    return createCapabilityStatus(
      'screen_capture',
      'blocked',
      checkedAt,
      'Screen recording permission is required before taking screenshots.',
      screenRecordingRemediation(),
      ERROR_CODES.SCREEN_RECORDING_PERMISSION_REQUIRED,
      readinessDetails(readiness)
    );
  }

  if (readiness.reasonCode === 'screen_capture_platform_unsupported') {
    return createCapabilityStatus(
      'screen_capture',
      'unknown',
      checkedAt,
      'Screen recording permission check is only available on macOS.',
      unknownRemediation(),
      ERROR_CODES.PLATFORM_UNSUPPORTED,
      readinessDetails(readiness)
    );
  }

  const message =
    readiness.reasonCode === 'screen_capture_probe_timeout'
      ? 'Screen recording readiness check timed out.'
      : 'Screen recording readiness could not be determined.';

  return createCapabilityStatus(
    'screen_capture',
    'unknown',
    checkedAt,
    message,
    unknownRemediation(),
    ERROR_CODES.SCREEN_RECORDING_STATUS_UNKNOWN,
    readinessDetails(readiness)
  );
}

function getAccessibilityStatus(
  checkedAt: string,
  readiness: DesktopControlCapabilityReadiness
): DesktopControlCapabilityStatus {
  if (readiness.state === 'ok') {
    return createCapabilityStatus(
      'action_execution',
      'ready',
      checkedAt,
      'Accessibility permission is granted.',
      readyRemediation(),
      null,
      readinessDetails(readiness)
    );
  }

  if (ACCESSIBILITY_PERMISSION_REASONS.has(readiness.reasonCode)) {
    return createCapabilityStatus(
      'action_execution',
      'blocked',
      checkedAt,
      'Accessibility permission is required before keyboard/mouse actions can run.',
      accessibilityRemediation(),
      ERROR_CODES.ACCESSIBILITY_PERMISSION_REQUIRED,
      readinessDetails(readiness)
    );
  }

  if (readiness.reasonCode === 'action_execution_platform_unsupported') {
    return createCapabilityStatus(
      'action_execution',
      'unknown',
      checkedAt,
      'Accessibility permission check is only available on macOS.',
      unknownRemediation(),
      ERROR_CODES.PLATFORM_UNSUPPORTED,
      readinessDetails(readiness)
    );
  }

  const message =
    readiness.reasonCode === 'action_execution_probe_timeout'
      ? 'Accessibility readiness check timed out.'
      : 'Accessibility readiness could not be determined.';

  return createCapabilityStatus(
    'action_execution',
    'unknown',
    checkedAt,
    message,
    unknownRemediation(),
    ERROR_CODES.ACCESSIBILITY_STATUS_UNKNOWN,
    readinessDetails(readiness)
  );
}

function getMcpHealthStatus(
  checkedAt: string,
  readiness: DesktopControlCapabilityReadiness
): DesktopControlCapabilityStatus {
  if (readiness.state === 'ok') {
    return createCapabilityStatus(
      'mcp_health',
      'ready',
      checkedAt,
      'MCP runtime dependencies are present.',
      readyRemediation(),
      null,
      readinessDetails(readiness, {
        signal: 'deterministic_readiness_probe',
        appReady: typeof app.isReady === 'function' ? app.isReady() : null,
      })
    );
  }

  if (readiness.state === 'unavailable') {
    return createCapabilityStatus(
      'mcp_health',
      'blocked',
      checkedAt,
      'Desktop control MCP runtime is unhealthy.',
      mcpRemediation(),
      ERROR_CODES.MCP_HEALTHCHECK_FAILED,
      readinessDetails(readiness)
    );
  }

  if (readiness.reasonCode === 'runtime_health_probe_timeout') {
    return createCapabilityStatus(
      'mcp_health',
      'unknown',
      checkedAt,
      'MCP health check timed out.',
      mcpRemediation(),
      ERROR_CODES.MCP_HEALTH_UNKNOWN,
      readinessDetails(readiness)
    );
  }

  return createCapabilityStatus(
    'mcp_health',
    'unknown',
    checkedAt,
    'MCP runtime health is degraded.',
    mcpRemediation(),
    ERROR_CODES.MCP_HEALTH_UNKNOWN,
    readinessDetails(readiness)
  );
}

function deriveOverallStatus(
  checks: SnapshotWithoutCache['checks']
): Pick<SnapshotWithoutCache, 'status' | 'errorCode' | 'message' | 'remediation'> {
  if (checks.mcp_health.status === 'blocked') {
    return {
      status: 'mcp_unhealthy',
      errorCode: checks.mcp_health.errorCode ?? ERROR_CODES.MCP_HEALTHCHECK_FAILED,
      message: checks.mcp_health.message,
      remediation: checks.mcp_health.remediation,
    };
  }

  if (checks.screen_capture.errorCode === ERROR_CODES.SCREEN_RECORDING_PERMISSION_REQUIRED) {
    return {
      status: 'needs_screen_recording_permission',
      errorCode: checks.screen_capture.errorCode,
      message: checks.screen_capture.message,
      remediation: checks.screen_capture.remediation,
    };
  }

  if (checks.action_execution.errorCode === ERROR_CODES.ACCESSIBILITY_PERMISSION_REQUIRED) {
    return {
      status: 'needs_accessibility_permission',
      errorCode: checks.action_execution.errorCode,
      message: checks.action_execution.message,
      remediation: checks.action_execution.remediation,
    };
  }

  if (
    checks.screen_capture.status !== 'ready' ||
    checks.action_execution.status !== 'ready' ||
    checks.mcp_health.status !== 'ready'
  ) {
    return {
      status: 'unknown',
      errorCode: ERROR_CODES.PREFLIGHT_UNKNOWN,
      message: 'Desktop control readiness could not be determined.',
      remediation: unknownRemediation(),
    };
  }

  return {
    status: 'ready',
    errorCode: null,
    message: 'Desktop control is ready.',
    remediation: readyRemediation(),
  };
}

function applyCacheMetadata(
  snapshot: SnapshotWithoutCache,
  fromCache: boolean,
  expiresAtMs: number
): DesktopControlStatusSnapshot {
  return {
    ...snapshot,
    cache: {
      ttlMs: PREFLIGHT_CACHE_TTL_MS,
      expiresAt: new Date(expiresAtMs).toISOString(),
      fromCache,
    },
  };
}

function createUnknownSnapshot(checkedAt: string, error: unknown): SnapshotWithoutCache {
  const cause = error instanceof Error ? error.message : String(error);
  const fallbackCheck = createCapabilityStatus(
    'mcp_health',
    'unknown',
    checkedAt,
    'Preflight failed unexpectedly.',
    unknownRemediation(),
    ERROR_CODES.PREFLIGHT_UNKNOWN,
    { cause }
  );

  return {
    status: 'unknown',
    errorCode: ERROR_CODES.PREFLIGHT_UNKNOWN,
    message: 'Desktop control readiness check failed unexpectedly.',
    remediation: unknownRemediation(),
    checkedAt,
    checks: {
      screen_capture: createCapabilityStatus(
        'screen_capture',
        'unknown',
        checkedAt,
        'Readiness check was not completed.',
        unknownRemediation(),
        ERROR_CODES.PREFLIGHT_UNKNOWN,
        { cause }
      ),
      action_execution: createCapabilityStatus(
        'action_execution',
        'unknown',
        checkedAt,
        'Readiness check was not completed.',
        unknownRemediation(),
        ERROR_CODES.PREFLIGHT_UNKNOWN,
        { cause }
      ),
      mcp_health: fallbackCheck,
    },
  };
}

export async function getDesktopControlStatus(
  options: { forceRefresh?: boolean } = {}
): Promise<DesktopControlStatusSnapshot> {
  const now = Date.now();

  if (!options.forceRefresh && cachedSnapshot && cachedSnapshot.expiresAtMs > now) {
    return applyCacheMetadata(cachedSnapshot.value, true, cachedSnapshot.expiresAtMs);
  }

  const checkedAt = new Date(now).toISOString();

  try {
    const readiness = await evaluateDesktopControlReadiness({ checkedAt });
    const checks = {
      screen_capture: getScreenCaptureStatus(checkedAt, readiness.checks.screen_capture),
      action_execution: getAccessibilityStatus(checkedAt, readiness.checks.action_execution),
      mcp_health: getMcpHealthStatus(checkedAt, readiness.checks.mcp_health),
    };

    const overall = deriveOverallStatus(checks);
    const snapshot: SnapshotWithoutCache = {
      ...overall,
      checkedAt,
      checks,
    };

    const expiresAtMs = now + PREFLIGHT_CACHE_TTL_MS;
    cachedSnapshot = { expiresAtMs, value: snapshot };

    return applyCacheMetadata(snapshot, false, expiresAtMs);
  } catch (error) {
    const snapshot = createUnknownSnapshot(checkedAt, error);
    const expiresAtMs = now + PREFLIGHT_CACHE_TTL_MS;
    cachedSnapshot = { expiresAtMs, value: snapshot };
    return applyCacheMetadata(snapshot, false, expiresAtMs);
  }
}
