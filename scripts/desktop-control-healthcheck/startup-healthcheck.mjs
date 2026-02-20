#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
const mainEntryPath = resolve(repoRoot, 'apps/desktop/dist-electron/main/index.js');
const playwrightEntryPath = resolve(
  repoRoot,
  'apps/desktop/node_modules/@playwright/test/index.js'
);
const REQUIRED_CAPABILITY_CHECKS = ['screen_capture', 'action_execution', 'mcp_health'];
const MACOS_REQUIRED_PERMISSION_CHECKS = ['screen_capture', 'action_execution'];
const CAPABILITY_LABELS = Object.freeze({
  screen_capture: 'Screen capture permission',
  action_execution: 'Accessibility permission',
  mcp_health: 'Runtime dependencies',
});
const DEFAULT_REMEDIATION_HINTS = Object.freeze({
  screen_capture: Object.freeze({
    title: 'Allow Screen Recording',
    systemSettingsPath: 'System Settings > Privacy & Security > Screen Recording',
    steps: Object.freeze([
      'Open System Settings > Privacy & Security > Screen Recording.',
      'Enable permission for Screen Agent.',
      'Quit and reopen Screen Agent, then run diagnostics again.',
    ]),
  }),
  action_execution: Object.freeze({
    title: 'Allow Accessibility',
    systemSettingsPath: 'System Settings > Privacy & Security > Accessibility',
    steps: Object.freeze([
      'Open System Settings > Privacy & Security > Accessibility.',
      'Enable permission for Screen Agent.',
      'Quit and reopen Screen Agent, then run diagnostics again.',
    ]),
  }),
  mcp_health: Object.freeze({
    title: 'Repair desktop runtime dependencies',
    steps: Object.freeze([
      'Rebuild the desktop app to refresh bundled assets and runtime paths.',
      'Verify skills and MCP entrypoints exist in the expected skills directory.',
      'Restart Screen Agent and run diagnostics again.',
    ]),
  }),
});

function reportFailure(message, details) {
  console.error(`[desktop-control-healthcheck] FAIL: ${message}`);
  if (details !== undefined) {
    try {
      console.error(JSON.stringify(details, null, 2));
    } catch {
      console.error(String(details));
    }
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function asStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === 'string' && entry.length > 0);
}

function asOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getReadinessReasonCode(check) {
  if (!isRecord(check)) {
    return null;
  }

  const details = check.details;
  if (!isRecord(details)) {
    return null;
  }

  return typeof details.readinessReasonCode === 'string' ? details.readinessReasonCode : null;
}

function createNoActionRemediation() {
  return {
    title: 'No action needed',
    steps: ['No remediation required for this check.'],
  };
}

function buildFallbackRemediation(capability) {
  const fallback = DEFAULT_REMEDIATION_HINTS[capability];
  if (!fallback) {
    return {
      title: 'Retry diagnostics',
      steps: ['Restart Screen Agent and rerun diagnostics.'],
    };
  }

  return {
    title: fallback.title,
    steps: [...fallback.steps],
    ...(typeof fallback.systemSettingsPath === 'string'
      ? { systemSettingsPath: fallback.systemSettingsPath }
      : {}),
  };
}

function normalizeRemediation(remediation, capability) {
  if (!isRecord(remediation)) {
    return buildFallbackRemediation(capability);
  }

  const title = asOptionalString(remediation.title);
  const steps = asStringArray(remediation.steps);
  const systemSettingsPath = asOptionalString(remediation.systemSettingsPath);

  if (!title || steps.length === 0) {
    return buildFallbackRemediation(capability);
  }

  return {
    title,
    steps,
    ...(systemSettingsPath ? { systemSettingsPath } : {}),
  };
}

function buildCheckSummary(snapshot) {
  const checks = isRecord(snapshot) && isRecord(snapshot.checks) ? snapshot.checks : {};
  const summary = {};

  for (const key of REQUIRED_CAPABILITY_CHECKS) {
    const check = checks[key];
    summary[key] = {
      status: isRecord(check) && typeof check.status === 'string' ? check.status : null,
      errorCode: isRecord(check) && typeof check.errorCode === 'string' ? check.errorCode : null,
      readinessReasonCode: getReadinessReasonCode(check),
    };
  }

  return summary;
}

export function buildMachineReadinessReport(
  snapshot,
  {
    platform,
    snapshotStatus,
    checkFailures = {},
    allFailures = [],
    generatedAt = new Date().toISOString(),
  } = {}
) {
  const checks = isRecord(snapshot) && isRecord(snapshot.checks) ? snapshot.checks : {};
  const allFailureHints = asStringArray(allFailures);
  const capabilityFailureHints = new Set(
    Object.values(checkFailures).flatMap((capabilityFailures) => asStringArray(capabilityFailures))
  );
  const globalFailureHints = allFailureHints.filter((hint) => !capabilityFailureHints.has(hint));

  const checkResults = REQUIRED_CAPABILITY_CHECKS.map((capability) => {
    const check = checks[capability];
    const failures = asStringArray(checkFailures[capability]);
    const passing = failures.length === 0;

    return {
      capability,
      label: CAPABILITY_LABELS[capability] ?? capability,
      result: passing ? 'pass' : 'fail',
      status: isRecord(check) ? asOptionalString(check.status) : null,
      message: isRecord(check) ? asOptionalString(check.message) : null,
      errorCode: isRecord(check) ? asOptionalString(check.errorCode) : null,
      readinessReasonCode: getReadinessReasonCode(check),
      failureHints: failures,
      remediation: passing
        ? createNoActionRemediation()
        : normalizeRemediation(isRecord(check) ? check.remediation : null, capability),
    };
  });

  const failedChecks = checkResults.filter((check) => check.result === 'fail').length;

  return {
    generatedAt,
    platform,
    snapshotStatus,
    overall: failedChecks === 0 && globalFailureHints.length === 0 ? 'pass' : 'fail',
    summary: {
      totalChecks: checkResults.length,
      passedChecks: checkResults.length - failedChecks,
      failedChecks,
      globalFailures: globalFailureHints.length,
    },
    globalFailureHints,
    checks: checkResults,
  };
}

export function validateStartupHealthSnapshot(snapshot, options = {}) {
  const platform = options.platform ?? process.platform;
  const failures = [];
  const checkFailures = Object.fromEntries(
    REQUIRED_CAPABILITY_CHECKS.map((capability) => [capability, []])
  );
  const generatedAt = new Date().toISOString();
  const addFailure = (message, capability) => {
    failures.push(message);
    if (
      typeof capability === 'string' &&
      Object.prototype.hasOwnProperty.call(checkFailures, capability)
    ) {
      checkFailures[capability].push(message);
    }
  };

  if (!isRecord(snapshot)) {
    addFailure('Readiness payload is not an object.');
    const machineReadinessReport = buildMachineReadinessReport(
      {},
      {
        platform,
        snapshotStatus: null,
        checkFailures,
        allFailures: failures,
        generatedAt,
      }
    );
    return {
      ok: false,
      failures,
      snapshotStatus: null,
      checkSummary: buildCheckSummary({}),
      machineReadinessReport,
    };
  }

  const snapshotStatus = typeof snapshot.status === 'string' ? snapshot.status : null;
  if (snapshotStatus === null) {
    addFailure('Readiness payload is missing string status.');
  }

  const checks = isRecord(snapshot.checks) ? snapshot.checks : {};
  if (!isRecord(snapshot.checks)) {
    addFailure('Readiness payload is missing checks object.');
  }

  for (const key of REQUIRED_CAPABILITY_CHECKS) {
    const check = checks[key];
    if (!isRecord(check)) {
      addFailure(`Required readiness check "${key}" is missing.`, key);
      continue;
    }

    if (typeof check.status !== 'string') {
      addFailure(`Readiness check "${key}" is missing status.`, key);
    }

    if (typeof check.message !== 'string' || check.message.length === 0) {
      addFailure(`Readiness check "${key}" is missing message.`, key);
    }
  }

  for (const key of MACOS_REQUIRED_PERMISSION_CHECKS) {
    const check = checks[key];
    if (!isRecord(check) || typeof check.status !== 'string') {
      continue;
    }

    if (platform === 'darwin') {
      if (check.status !== 'ready') {
        const reasonCode = getReadinessReasonCode(check);
        const reasonSuffix =
          typeof reasonCode === 'string' && reasonCode.length > 0 ? ` (${reasonCode})` : '';
        addFailure(`macOS permission check "${key}" is not ready${reasonSuffix}.`, key);
      }
      continue;
    }

    if (check.status === 'blocked') {
      addFailure(`Permission check "${key}" is blocked on ${platform}.`, key);
      continue;
    }

    if (
      check.status === 'unknown' &&
      !(typeof check.errorCode === 'string' && check.errorCode === 'platform_unsupported')
    ) {
      const reasonCode = getReadinessReasonCode(check);
      const reasonSuffix =
        typeof reasonCode === 'string' && reasonCode.length > 0 ? ` (${reasonCode})` : '';
      addFailure(`Permission check "${key}" is unknown on ${platform}${reasonSuffix}.`, key);
    }
  }

  const runtimeCheck = checks.mcp_health;
  if (isRecord(runtimeCheck)) {
    if (runtimeCheck.status !== 'ready') {
      const reasonCode = getReadinessReasonCode(runtimeCheck);
      const reasonSuffix =
        typeof reasonCode === 'string' && reasonCode.length > 0 ? ` (${reasonCode})` : '';
      addFailure(`Runtime dependency check "mcp_health" is not ready${reasonSuffix}.`, 'mcp_health');
    }

    const details = isRecord(runtimeCheck.details) ? runtimeCheck.details : null;
    if (!details) {
      addFailure('Runtime dependency check "mcp_health" is missing details metadata.', 'mcp_health');
    } else {
      if (typeof details.runnerPath !== 'string' || details.runnerPath.length === 0) {
        addFailure('Runtime dependency check "mcp_health" is missing runnerPath.', 'mcp_health');
      }

      const missingCoreEntrypoints = asStringArray(details.missingCoreEntrypoints);
      if (missingCoreEntrypoints.length > 0) {
        addFailure(
          `Runtime dependency check has missing core entrypoints (${missingCoreEntrypoints.length}).`,
          'mcp_health'
        );
      }

      const missingSupportEntrypoints = asStringArray(details.missingSupportEntrypoints);
      if (missingSupportEntrypoints.length > 0) {
        addFailure(
          `Runtime dependency check has missing support entrypoints (${missingSupportEntrypoints.length}).`,
          'mcp_health'
        );
      }
    }
  }

  const machineReadinessReport = buildMachineReadinessReport(snapshot, {
    platform,
    snapshotStatus,
    checkFailures,
    allFailures: failures,
    generatedAt,
  });

  return {
    ok: failures.length === 0,
    failures,
    snapshotStatus,
    checkSummary: buildCheckSummary(snapshot),
    machineReadinessReport,
  };
}

async function run() {
  if (!existsSync(playwrightEntryPath)) {
    reportFailure('Playwright test runtime is not installed for apps/desktop.', {
      expectedPlaywrightEntry: playwrightEntryPath,
      hint: 'Run \"pnpm install\" before this healthcheck.',
    });
    process.exit(1);
  }

  if (!existsSync(mainEntryPath)) {
    reportFailure('Desktop app is not built.', {
      expectedMainEntry: mainEntryPath,
      hint: 'Run "pnpm -F @accomplish/desktop build" before this healthcheck.',
    });
    process.exit(1);
  }

  const playwright = await import(pathToFileURL(playwrightEntryPath).href);
  const electron = playwright?._electron ?? playwright?.default?._electron;

  if (!electron || typeof electron.launch !== 'function') {
    reportFailure('Failed to load Playwright Electron launcher.', {
      expectedPlaywrightEntry: playwrightEntryPath,
    });
    process.exit(1);
  }

  const app = await electron.launch({
    args: [mainEntryPath, '--e2e-skip-auth', '--e2e-mock-tasks'],
    env: {
      ...process.env,
      E2E_SKIP_AUTH: '1',
      E2E_MOCK_TASK_EVENTS: '1',
      NODE_ENV: 'test',
    },
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('load');
    try {
      await window.waitForFunction(() => typeof window.accomplish === 'object', null, {
        timeout: 10_000,
      });
    } catch (error) {
      reportFailure('Renderer bridge did not initialize within timeout.', {
        message: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }

    const result = await window.evaluate(async () => {
      const api = window.accomplish;
      if (!api || typeof api !== 'object') {
        return {
          ok: false,
          reason: 'window.accomplish is unavailable in renderer',
        };
      }

      if (typeof api.getVersion !== 'function') {
        return {
          ok: false,
          reason: 'window.accomplish.getVersion is unavailable',
          availableKeys: Object.keys(api),
        };
      }

      const version = await api.getVersion();
      if (typeof version !== 'string' || version.length === 0) {
        return {
          ok: false,
          reason: 'window.accomplish.getVersion returned invalid payload',
          payload: version,
        };
      }

      const readiness = (() => {
        if (typeof api.getDesktopControlStatus === 'function') {
          return {
            method: 'getDesktopControlStatus',
            invoke: () => api.getDesktopControlStatus({ forceRefresh: true }),
          };
        }

        if (typeof api.desktopControlGetStatus === 'function') {
          return {
            method: 'desktopControlGetStatus',
            invoke: () => api.desktopControlGetStatus({ forceRefresh: true }),
          };
        }

        if (
          typeof api.desktopControl === 'object' &&
          api.desktopControl !== null &&
          typeof api.desktopControl.getStatus === 'function'
        ) {
          return {
            method: 'desktopControl.getStatus',
            invoke: () => api.desktopControl.getStatus({ forceRefresh: true }),
          };
        }

        return null;
      })();

      if (!readiness) {
        return {
          ok: false,
          reason: 'No desktop-control readiness API found in renderer bridge',
          availableKeys: Object.keys(api),
        };
      }

      try {
        const payload = await readiness.invoke();
        if (!payload || typeof payload !== 'object') {
          return {
            ok: false,
            reason: `Readiness API ${readiness.method} returned non-object payload`,
            payloadType: typeof payload,
          };
        }

        const status = payload.status;
        const checks = payload.checks;

        if (typeof status !== 'string') {
          return {
            ok: false,
            reason: `Readiness API ${readiness.method} returned payload without status`,
            payload,
          };
        }

        if (!checks || typeof checks !== 'object') {
          return {
            ok: false,
            reason: `Readiness API ${readiness.method} returned payload without checks`,
            payload,
          };
        }

        return {
          ok: true,
          appVersion: version,
          readinessMethod: readiness.method,
          readinessStatus: status,
          readinessChecks: Object.keys(checks),
          readinessPayload: payload,
        };
      } catch (error) {
        return {
          ok: false,
          reason: `Readiness API ${readiness.method} threw`,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    if (!result || typeof result !== 'object' || result.ok !== true) {
      reportFailure('Renderer preload + IPC readiness wiring check failed.', result);
      process.exit(1);
    }

    const missingChecks = REQUIRED_CAPABILITY_CHECKS.filter(
      (key) => !(result.readinessChecks || []).includes(key)
    );

    if (missingChecks.length > 0) {
      reportFailure('Readiness payload is missing required capability checks.', {
        missingChecks,
        readinessChecks: result.readinessChecks,
      });
      process.exit(1);
    }

    const validation = validateStartupHealthSnapshot(result.readinessPayload);
    console.log('[desktop-control-healthcheck] MACHINE READINESS REPORT');
    console.log(JSON.stringify(validation.machineReadinessReport, null, 2));

    if (!validation.ok) {
      reportFailure('Startup readiness validation failed for permissions/dependencies.', {
        readinessMethod: result.readinessMethod,
        readinessStatus: validation.snapshotStatus,
        checkSummary: validation.checkSummary,
        machineReadinessReport: validation.machineReadinessReport,
        failures: validation.failures,
      });
      process.exit(1);
    }

    console.log('[desktop-control-healthcheck] PASS');
    console.log(
      JSON.stringify(
        {
          appVersion: result.appVersion,
          readinessMethod: result.readinessMethod,
          readinessStatus: result.readinessStatus,
          readinessChecks: result.readinessChecks,
          checkSummary: validation.checkSummary,
          machineReadinessReport: validation.machineReadinessReport,
        },
        null,
        2
      )
    );
  } finally {
    await app.close();
  }
}

function isDirectExecution() {
  if (typeof process.argv[1] !== 'string' || process.argv[1].length === 0) {
    return false;
  }

  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectExecution()) {
  run().catch((error) => {
    reportFailure('Unexpected healthcheck execution error.', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
