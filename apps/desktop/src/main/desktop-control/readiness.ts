import fs from 'fs';
import path from 'path';
import { systemPreferences } from 'electron';
import { getSkillsPath } from '../opencode/config-generator';
import { getNpxPath } from '../utils/bundled-node';

export type DesktopControlReadinessCapability =
  | 'screen_capture'
  | 'action_execution'
  | 'mcp_health';

export type DesktopControlReadinessState = 'ok' | 'degraded' | 'unavailable';

export interface DesktopControlCapabilityRetryPolicy {
  timeoutMs: number;
  maxAttempts: number;
}

export interface DesktopControlCapabilityAttempt {
  attempt: number;
  durationMs: number;
  outcome: 'ok' | 'timeout' | 'error';
  reasonCode?: string;
  error?: string;
}

export interface DesktopControlCapabilityProbeResult {
  state: DesktopControlReadinessState;
  reasonCode: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface DesktopControlCapabilityReadiness {
  capability: DesktopControlReadinessCapability;
  state: DesktopControlReadinessState;
  reasonCode: string;
  message: string;
  checkedAt: string;
  attempts: DesktopControlCapabilityAttempt[];
  retryPolicy: DesktopControlCapabilityRetryPolicy;
  details?: Record<string, unknown>;
}

export interface DesktopControlReadinessSnapshot {
  checkedAt: string;
  checks: Record<DesktopControlReadinessCapability, DesktopControlCapabilityReadiness>;
}

type MaybePromise<T> = T | Promise<T>;
type CapabilityProbe = () => MaybePromise<DesktopControlCapabilityProbeResult>;

export interface DesktopControlReadinessDependencies {
  platform: string;
  getScreenMediaAccessStatus: () => MaybePromise<string>;
  isAccessibilityTrusted: () => MaybePromise<boolean>;
  getSkillsPath: () => MaybePromise<string>;
  getNpxPath: () => MaybePromise<string>;
  fileExists: (targetPath: string) => MaybePromise<boolean>;
  now: () => number;
}

export interface EvaluateDesktopControlReadinessOptions {
  checkedAt?: string;
  retryPolicy?: Partial<
    Record<DesktopControlReadinessCapability, Partial<DesktopControlCapabilityRetryPolicy>>
  >;
  dependencies?: Partial<DesktopControlReadinessDependencies>;
}

export const DEFAULT_READINESS_RETRY_POLICY: Record<
  DesktopControlReadinessCapability,
  DesktopControlCapabilityRetryPolicy
> = Object.freeze({
  screen_capture: Object.freeze({ timeoutMs: 200, maxAttempts: 2 }),
  action_execution: Object.freeze({ timeoutMs: 200, maxAttempts: 2 }),
  mcp_health: Object.freeze({ timeoutMs: 400, maxAttempts: 3 }),
});

class CapabilityTimeoutError extends Error {
  readonly capability: DesktopControlReadinessCapability;
  readonly timeoutMs: number;

  constructor(capability: DesktopControlReadinessCapability, timeoutMs: number) {
    super(`${capability} readiness probe timed out after ${timeoutMs}ms`);
    this.name = 'CapabilityTimeoutError';
    this.capability = capability;
    this.timeoutMs = timeoutMs;
  }
}

function isCapabilityTimeoutError(error: unknown): error is CapabilityTimeoutError {
  return error instanceof CapabilityTimeoutError;
}

function timeoutReasonCode(capability: DesktopControlReadinessCapability): string {
  if (capability === 'screen_capture') return 'screen_capture_probe_timeout';
  if (capability === 'action_execution') return 'action_execution_probe_timeout';
  return 'runtime_health_probe_timeout';
}

function failureReasonCode(capability: DesktopControlReadinessCapability): string {
  if (capability === 'screen_capture') return 'screen_capture_probe_failed';
  if (capability === 'action_execution') return 'action_execution_probe_failed';
  return 'runtime_health_probe_failed';
}

function capabilityLabel(capability: DesktopControlReadinessCapability): string {
  if (capability === 'screen_capture') return 'Screen capture';
  if (capability === 'action_execution') return 'Action execution';
  return 'Runtime health';
}

function toSafeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeRetryPolicy(
  policy: Partial<DesktopControlCapabilityRetryPolicy> | undefined,
  fallback: DesktopControlCapabilityRetryPolicy
): DesktopControlCapabilityRetryPolicy {
  const timeoutMs = Math.max(1, Math.floor(policy?.timeoutMs ?? fallback.timeoutMs));
  const maxAttempts = Math.max(1, Math.floor(policy?.maxAttempts ?? fallback.maxAttempts));
  return { timeoutMs, maxAttempts };
}

async function withTimeout<T>(
  capability: DesktopControlReadinessCapability,
  timeoutMs: number,
  operation: () => MaybePromise<T>
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new CapabilityTimeoutError(capability, timeoutMs));
    }, timeoutMs);

    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

export async function evaluateCapabilityReadiness(
  capability: DesktopControlReadinessCapability,
  probe: CapabilityProbe,
  retryPolicy: DesktopControlCapabilityRetryPolicy,
  checkedAt: string,
  now: () => number = () => Date.now()
): Promise<DesktopControlCapabilityReadiness> {
  const attempts: DesktopControlCapabilityAttempt[] = [];

  for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
    const startedAt = now();
    try {
      const outcome = await withTimeout(capability, retryPolicy.timeoutMs, probe);
      attempts.push({
        attempt,
        durationMs: Math.max(0, now() - startedAt),
        outcome: 'ok',
        reasonCode: outcome.reasonCode,
      });

      if (outcome.retryable && attempt < retryPolicy.maxAttempts) {
        continue;
      }

      return {
        capability,
        state: outcome.state,
        reasonCode: outcome.reasonCode,
        message: outcome.message,
        checkedAt,
        attempts,
        retryPolicy,
        details: outcome.details,
      };
    } catch (error) {
      const timedOut = isCapabilityTimeoutError(error);
      const reasonCode = timedOut ? timeoutReasonCode(capability) : failureReasonCode(capability);
      const errorMessage = toSafeErrorMessage(error);

      attempts.push({
        attempt,
        durationMs: Math.max(0, now() - startedAt),
        outcome: timedOut ? 'timeout' : 'error',
        reasonCode,
        error: errorMessage,
      });

      if (attempt < retryPolicy.maxAttempts) {
        continue;
      }

      const label = capabilityLabel(capability);
      const message = timedOut
        ? `${label} readiness check timed out.`
        : `${label} readiness check failed.`;

      return {
        capability,
        state: 'degraded',
        reasonCode,
        message,
        checkedAt,
        attempts,
        retryPolicy,
        details: {
          cause: errorMessage,
        },
      };
    }
  }

  return {
    capability,
    state: 'degraded',
    reasonCode: failureReasonCode(capability),
    message: `${capabilityLabel(capability)} readiness check failed.`,
    checkedAt,
    attempts,
    retryPolicy,
  };
}

function createDefaultDependencies(): DesktopControlReadinessDependencies {
  return {
    platform: process.platform,
    getScreenMediaAccessStatus: () => systemPreferences.getMediaAccessStatus('screen'),
    isAccessibilityTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
    getSkillsPath,
    getNpxPath,
    fileExists: (targetPath: string) => fs.existsSync(targetPath),
    now: () => Date.now(),
  };
}

function resolveDependencies(
  overrides: Partial<DesktopControlReadinessDependencies> = {}
): DesktopControlReadinessDependencies {
  return {
    ...createDefaultDependencies(),
    ...overrides,
  };
}

async function runScreenCaptureProbe(
  dependencies: DesktopControlReadinessDependencies
): Promise<DesktopControlCapabilityProbeResult> {
  if (dependencies.platform !== 'darwin') {
    return {
      state: 'unavailable',
      reasonCode: 'screen_capture_platform_unsupported',
      message: 'Screen recording permission checks are only available on macOS.',
      details: {
        platform: dependencies.platform,
      },
    };
  }

  const status = await dependencies.getScreenMediaAccessStatus();

  if (status === 'granted') {
    return {
      state: 'ok',
      reasonCode: 'screen_capture_ok',
      message: 'Screen recording permission is granted.',
      details: {
        mediaAccessStatus: status,
      },
    };
  }

  if (status === 'denied') {
    return {
      state: 'unavailable',
      reasonCode: 'screen_capture_permission_denied',
      message: 'Screen recording permission is denied.',
      details: {
        mediaAccessStatus: status,
      },
    };
  }

  if (status === 'restricted') {
    return {
      state: 'unavailable',
      reasonCode: 'screen_capture_permission_restricted',
      message: 'Screen recording permission is restricted by system policy.',
      details: {
        mediaAccessStatus: status,
      },
    };
  }

  if (status === 'not-determined') {
    return {
      state: 'unavailable',
      reasonCode: 'screen_capture_permission_not_determined',
      message: 'Screen recording permission has not been granted yet.',
      details: {
        mediaAccessStatus: status,
      },
    };
  }

  return {
    state: 'degraded',
    reasonCode: 'screen_capture_status_unknown',
    message: `Unexpected screen recording permission state: ${status}.`,
    details: {
      mediaAccessStatus: status,
    },
  };
}

async function runActionExecutionProbe(
  dependencies: DesktopControlReadinessDependencies
): Promise<DesktopControlCapabilityProbeResult> {
  if (dependencies.platform !== 'darwin') {
    return {
      state: 'unavailable',
      reasonCode: 'action_execution_platform_unsupported',
      message: 'Accessibility checks are only available on macOS.',
      details: {
        platform: dependencies.platform,
      },
    };
  }

  const trusted = await dependencies.isAccessibilityTrusted();
  if (trusted) {
    return {
      state: 'ok',
      reasonCode: 'action_execution_ok',
      message: 'Accessibility permission is granted.',
      details: {
        accessibilityTrusted: true,
      },
    };
  }

  return {
    state: 'unavailable',
    reasonCode: 'action_execution_permission_denied',
    message: 'Accessibility permission is required before desktop actions can run.',
    details: {
      accessibilityTrusted: false,
    },
  };
}

function runtimeEntrypoints(skillsPath: string): {
  core: string[];
  support: string[];
} {
  return {
    core: [
      path.join(skillsPath, 'screen-capture', 'src', 'index.ts'),
      path.join(skillsPath, 'action-executor', 'src', 'index.ts'),
    ],
    support: [path.join(skillsPath, 'file-permission', 'src', 'index.ts')],
  };
}

async function runRuntimeHealthProbe(
  dependencies: DesktopControlReadinessDependencies
): Promise<DesktopControlCapabilityProbeResult> {
  const skillsPath = await dependencies.getSkillsPath();
  const npxPath = await dependencies.getNpxPath();
  const entrypoints = runtimeEntrypoints(skillsPath);
  const missingCore: string[] = [];
  const missingSupport: string[] = [];

  for (const entrypoint of entrypoints.core) {
    if (!(await dependencies.fileExists(entrypoint))) {
      missingCore.push(entrypoint);
    }
  }

  for (const entrypoint of entrypoints.support) {
    if (!(await dependencies.fileExists(entrypoint))) {
      missingSupport.push(entrypoint);
    }
  }

  const runnerMissing =
    typeof npxPath === 'string' && path.isAbsolute(npxPath) && !(await dependencies.fileExists(npxPath));
  const hasCriticalIssue = runnerMissing || missingCore.length > 0;

  if (hasCriticalIssue) {
    const reasonCode = runnerMissing
      ? missingCore.length > 0
        ? 'runtime_health_runner_and_core_missing'
        : 'runtime_health_runner_missing'
      : 'runtime_health_missing_core_entrypoints';
    const issues: string[] = [];

    if (runnerMissing) {
      issues.push(`MCP runner is missing: ${npxPath}`);
    }
    if (missingCore.length > 0) {
      issues.push(`${missingCore.length} core MCP entrypoint(s) missing`);
    }

    if (missingSupport.length > 0) {
      issues.push(`${missingSupport.length} support MCP entrypoint(s) missing`);
    }

    return {
      state: 'unavailable',
      reasonCode,
      message: 'Desktop control runtime dependencies are missing.',
      details: {
        runnerPath: npxPath,
        issues,
        missingCoreEntrypoints: missingCore,
        missingSupportEntrypoints: missingSupport,
      },
    };
  }

  if (missingSupport.length > 0) {
    return {
      state: 'degraded',
      reasonCode: 'runtime_health_missing_support_entrypoints',
      message: 'Desktop control runtime is partially degraded.',
      details: {
        runnerPath: npxPath,
        issues: [`${missingSupport.length} support MCP entrypoint(s) missing`],
        missingCoreEntrypoints: [],
        missingSupportEntrypoints: missingSupport,
      },
    };
  }

  return {
    state: 'ok',
    reasonCode: 'runtime_health_ok',
    message: 'Desktop control runtime dependencies are present.',
    details: {
      runnerPath: npxPath,
      missingCoreEntrypoints: [],
      missingSupportEntrypoints: [],
    },
  };
}

export async function evaluateDesktopControlReadiness(
  options: EvaluateDesktopControlReadinessOptions = {}
): Promise<DesktopControlReadinessSnapshot> {
  const dependencies = resolveDependencies(options.dependencies);
  const checkedAt = options.checkedAt ?? new Date(dependencies.now()).toISOString();
  const retryPolicy = {
    screen_capture: normalizeRetryPolicy(
      options.retryPolicy?.screen_capture,
      DEFAULT_READINESS_RETRY_POLICY.screen_capture
    ),
    action_execution: normalizeRetryPolicy(
      options.retryPolicy?.action_execution,
      DEFAULT_READINESS_RETRY_POLICY.action_execution
    ),
    mcp_health: normalizeRetryPolicy(
      options.retryPolicy?.mcp_health,
      DEFAULT_READINESS_RETRY_POLICY.mcp_health
    ),
  };

  const checks: Record<DesktopControlReadinessCapability, DesktopControlCapabilityReadiness> = {
    screen_capture: await evaluateCapabilityReadiness(
      'screen_capture',
      () => runScreenCaptureProbe(dependencies),
      retryPolicy.screen_capture,
      checkedAt,
      dependencies.now
    ),
    action_execution: await evaluateCapabilityReadiness(
      'action_execution',
      () => runActionExecutionProbe(dependencies),
      retryPolicy.action_execution,
      checkedAt,
      dependencies.now
    ),
    mcp_health: await evaluateCapabilityReadiness(
      'mcp_health',
      () => runRuntimeHealthProbe(dependencies),
      retryPolicy.mcp_health,
      checkedAt,
      dependencies.now
    ),
  };

  return {
    checkedAt,
    checks,
  };
}
