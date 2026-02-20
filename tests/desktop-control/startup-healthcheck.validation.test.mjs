import test from 'node:test';
import assert from 'node:assert/strict';

import { validateStartupHealthSnapshot } from '../../scripts/desktop-control-healthcheck/startup-healthcheck.mjs';

function createReadySnapshot() {
  return {
    status: 'ready',
    checks: {
      screen_capture: {
        status: 'ready',
        message: 'Screen recording permission is granted.',
        errorCode: null,
        remediation: {
          title: 'Allow Screen Recording',
          systemSettingsPath: 'System Settings > Privacy & Security > Screen Recording',
          steps: ['Enable Screen Agent and restart the app.'],
        },
        details: {
          readinessReasonCode: 'screen_capture_ok',
        },
      },
      action_execution: {
        status: 'ready',
        message: 'Accessibility permission is granted.',
        errorCode: null,
        remediation: {
          title: 'Allow Accessibility',
          systemSettingsPath: 'System Settings > Privacy & Security > Accessibility',
          steps: ['Enable Screen Agent and restart the app.'],
        },
        details: {
          readinessReasonCode: 'action_execution_ok',
        },
      },
      mcp_health: {
        status: 'ready',
        message: 'MCP runtime dependencies are present.',
        errorCode: null,
        remediation: {
          title: 'Repair desktop runtime dependencies',
          steps: ['Rebuild app resources and rerun diagnostics.'],
        },
        details: {
          readinessReasonCode: 'runtime_health_ok',
          runnerPath: '/tmp/fake/npx',
          missingCoreEntrypoints: [],
          missingSupportEntrypoints: [],
        },
      },
    },
  };
}

test('passes when macOS permissions and runtime dependencies are ready', () => {
  const result = validateStartupHealthSnapshot(createReadySnapshot(), { platform: 'darwin' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.machineReadinessReport.overall, 'pass');
  assert.equal(result.machineReadinessReport.summary.failedChecks, 0);
  assert.equal(result.machineReadinessReport.checks.length, 3);
  assert.ok(result.machineReadinessReport.checks.every((check) => check.result === 'pass'));
});

test('fails when screen capture permission is not ready on macOS', () => {
  const snapshot = createReadySnapshot();
  snapshot.checks.screen_capture.status = 'blocked';
  snapshot.checks.screen_capture.errorCode = 'screen_recording_permission_required';
  snapshot.checks.screen_capture.details.readinessReasonCode = 'screen_capture_permission_denied';

  const result = validateStartupHealthSnapshot(snapshot, { platform: 'darwin' });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((message) => message.includes('screen_capture')));
  assert.equal(result.machineReadinessReport.overall, 'fail');
  const reportCheck = result.machineReadinessReport.checks.find(
    (check) => check.capability === 'screen_capture'
  );
  assert.ok(reportCheck);
  assert.equal(reportCheck.result, 'fail');
  assert.ok(reportCheck.failureHints.some((hint) => hint.includes('screen_capture')));
  assert.equal(reportCheck.remediation.title, 'Allow Screen Recording');
  assert.ok(reportCheck.remediation.steps.length > 0);
});

test('fails when runtime dependencies report missing entrypoints', () => {
  const snapshot = createReadySnapshot();
  snapshot.checks.mcp_health.status = 'unknown';
  snapshot.checks.mcp_health.errorCode = 'mcp_health_unknown';
  snapshot.checks.mcp_health.details.readinessReasonCode =
    'runtime_health_missing_support_entrypoints';
  snapshot.checks.mcp_health.details.missingSupportEntrypoints = [
    '/tmp/skills/live-screen-stream/src/index.ts',
  ];

  const result = validateStartupHealthSnapshot(snapshot, { platform: 'darwin' });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((message) => message.includes('mcp_health')));
  assert.ok(result.failures.some((message) => message.includes('support entrypoints')));
  const runtimeCheck = result.machineReadinessReport.checks.find(
    (check) => check.capability === 'mcp_health'
  );
  assert.ok(runtimeCheck);
  assert.equal(runtimeCheck.result, 'fail');
  assert.ok(runtimeCheck.failureHints.some((hint) => hint.includes('support entrypoints')));
  assert.equal(runtimeCheck.remediation.title, 'Repair desktop runtime dependencies');
});

test('allows platform_unsupported permission checks on non-macOS', () => {
  const snapshot = createReadySnapshot();
  snapshot.checks.screen_capture.status = 'unknown';
  snapshot.checks.screen_capture.errorCode = 'platform_unsupported';
  snapshot.checks.screen_capture.details.readinessReasonCode = 'screen_capture_platform_unsupported';

  snapshot.checks.action_execution.status = 'unknown';
  snapshot.checks.action_execution.errorCode = 'platform_unsupported';
  snapshot.checks.action_execution.details.readinessReasonCode =
    'action_execution_platform_unsupported';

  const result = validateStartupHealthSnapshot(snapshot, { platform: 'linux' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.machineReadinessReport.overall, 'pass');
  assert.ok(
    result.machineReadinessReport.checks
      .filter((check) => check.capability !== 'mcp_health')
      .every((check) => check.result === 'pass')
  );
});
