import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

test.describe.configure({ mode: 'serial' });

type DesktopControlStatusRequest = { forceRefresh?: boolean };

type DesktopControlCapabilityName = 'screen_capture' | 'action_execution';

type DesktopControlCapabilityCheck = {
  status?: unknown;
  message?: unknown;
  details?: unknown;
};

type DesktopControlStatusSnapshot = {
  checkedAt?: unknown;
  cache?: {
    fromCache?: unknown;
    ttlMs?: unknown;
    expiresAt?: unknown;
  };
  checks?: {
    screen_capture?: DesktopControlCapabilityCheck;
    action_execution?: DesktopControlCapabilityCheck;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertIsoDateString(value: unknown, label: string): asserts value is string {
  expect(typeof value, `${label} should be an ISO date string`).toBe('string');
  expect(Number.isNaN(Date.parse(value as string)), `${label} should parse as a valid date`).toBe(false);
}

function assertReliabilityMetadata(snapshot: DesktopControlStatusSnapshot, capability: DesktopControlCapabilityName): void {
  const check = snapshot.checks?.[capability];
  expect(isRecord(check), `${capability} check should be present`).toBe(true);

  const status = check?.status;
  expect(
    ['ready', 'blocked', 'unknown'].includes(String(status)),
    `${capability} status should be one of ready/blocked/unknown`
  ).toBe(true);

  const message = check?.message;
  expect(typeof message, `${capability} check should include a message`).toBe('string');
  expect((message as string).trim().length, `${capability} message should not be empty`).toBeGreaterThan(0);

  const details = check?.details;
  expect(isRecord(details), `${capability} check should include details`).toBe(true);

  const readinessState = details?.readinessState;
  expect(
    ['ok', 'degraded', 'unavailable'].includes(String(readinessState)),
    `${capability} readinessState should be one of ok/degraded/unavailable`
  ).toBe(true);

  const readinessReasonCode = details?.readinessReasonCode;
  expect(
    typeof readinessReasonCode === 'string' && readinessReasonCode.length > 0,
    `${capability} readinessReasonCode should be a non-empty string`
  ).toBe(true);

  const retryPolicy = details?.retryPolicy;
  expect(isRecord(retryPolicy), `${capability} details.retryPolicy should be present`).toBe(true);
  expect(
    typeof retryPolicy?.timeoutMs === 'number' && retryPolicy.timeoutMs > 0,
    `${capability} retryPolicy.timeoutMs should be > 0`
  ).toBe(true);
  expect(
    typeof retryPolicy?.maxAttempts === 'number' && retryPolicy.maxAttempts >= 1,
    `${capability} retryPolicy.maxAttempts should be >= 1`
  ).toBe(true);

  const attempts = details?.attempts;
  expect(Array.isArray(attempts), `${capability} details.attempts should be an array`).toBe(true);
  expect((attempts as unknown[]).length, `${capability} should record at least one probe attempt`).toBeGreaterThan(0);
  expect(
    (attempts as unknown[]).length <= Number(retryPolicy?.maxAttempts),
    `${capability} attempts should not exceed maxAttempts`
  ).toBe(true);

  for (let index = 0; index < (attempts as unknown[]).length; index += 1) {
    const attempt = (attempts as unknown[])[index];
    expect(isRecord(attempt), `${capability} attempt ${index + 1} should be an object`).toBe(true);
    expect(attempt?.attempt, `${capability} attempts should be 1-indexed and ordered`).toBe(index + 1);
    expect(
      typeof attempt?.durationMs === 'number' && attempt.durationMs >= 0,
      `${capability} attempt durationMs should be >= 0`
    ).toBe(true);
    expect(
      ['ok', 'timeout', 'error'].includes(String(attempt?.outcome)),
      `${capability} attempt outcome should be ok/timeout/error`
    ).toBe(true);
  }
}

async function readDesktopControlStatus(
  window: Page,
  options?: DesktopControlStatusRequest
): Promise<DesktopControlStatusSnapshot> {
  const statusCall = await window.evaluate(async (requestOptions) => {
    const api = window.accomplish as
      | {
          getDesktopControlStatus?: (opts?: { forceRefresh?: boolean }) => Promise<unknown>;
          desktopControlGetStatus?: (opts?: { forceRefresh?: boolean }) => Promise<unknown>;
          desktopControl?: { getStatus?: (opts?: { forceRefresh?: boolean }) => Promise<unknown> };
        }
      | undefined;

    if (!api || typeof api !== 'object') {
      return {
        ok: false,
        reason: 'window.accomplish bridge is unavailable in renderer',
      };
    }

    const resolvers: Array<[string, (() => Promise<unknown>) | undefined]> = [
      [
        'getDesktopControlStatus',
        typeof api.getDesktopControlStatus === 'function'
          ? () => api.getDesktopControlStatus(requestOptions)
          : undefined,
      ],
      [
        'desktopControlGetStatus',
        typeof api.desktopControlGetStatus === 'function'
          ? () => api.desktopControlGetStatus(requestOptions)
          : undefined,
      ],
      [
        'desktopControl.getStatus',
        typeof api.desktopControl === 'object' &&
        api.desktopControl !== null &&
        typeof api.desktopControl.getStatus === 'function'
          ? () => api.desktopControl!.getStatus!(requestOptions)
          : undefined,
      ],
    ];

    const selected = resolvers.find(([, invoke]) => typeof invoke === 'function');
    if (!selected) {
      return {
        ok: false,
        reason: 'No desktop-control readiness API was found on the renderer bridge',
        details: { availableKeys: Object.keys(api) },
      };
    }

    const [method, invoke] = selected;

    try {
      const payload = await invoke!();
      if (!payload || typeof payload !== 'object') {
        return {
          ok: false,
          reason: `Readiness API ${method} returned a non-object payload`,
          details: { payloadType: typeof payload },
        };
      }

      return {
        ok: true,
        method,
        payload,
      };
    } catch (error) {
      return {
        ok: false,
        reason: `Readiness API ${method} threw during invocation`,
        details: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }, options ?? {});

  expect(statusCall, JSON.stringify(statusCall, null, 2)).toMatchObject({ ok: true });

  const payload = (statusCall as { payload?: unknown }).payload;
  expect(isRecord(payload), 'Desktop control status payload should be an object').toBe(true);

  return payload as DesktopControlStatusSnapshot;
}

async function getRendererWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const windows = app.windows();
    for (const window of windows) {
      const url = window.url();
      if (url.startsWith('devtools://') || url.startsWith('chrome-devtools://')) {
        continue;
      }

      await window.waitForLoadState('load');
      return window;
    }

    try {
      await app.waitForEvent('window', { timeout: 1_000 });
    } catch {
      // Continue polling until timeout to handle slower renderer startup.
    }
  }

  throw new Error('Unable to locate renderer window (non-DevTools) within 15s.');
}

async function launchDesktopApp() {
  const mainEntryPath = resolve(process.cwd(), '../../apps/desktop/dist-electron/main/index.js');
  expect(
    existsSync(mainEntryPath),
    `Desktop main entry missing at ${mainEntryPath}. Run desktop build first.`
  ).toBe(true);

  const app = await electron.launch({
    args: [mainEntryPath, '--e2e-skip-auth', '--e2e-mock-tasks'],
    env: {
      ...process.env,
      E2E_SKIP_AUTH: '1',
      E2E_MOCK_TASK_EVENTS: '1',
      NODE_ENV: 'test',
    },
  });

  const window = await getRendererWindow(app);

  return { app, window };
}

test('desktop-control bridge reports screenshot/action reliability metadata', async () => {
  const { app, window } = await launchDesktopApp();

  try {
    const snapshot = await readDesktopControlStatus(window, { forceRefresh: true });

    assertIsoDateString(snapshot.checkedAt, 'snapshot.checkedAt');

    const cache = snapshot.cache;
    expect(isRecord(cache), 'snapshot.cache should be present').toBe(true);
    expect(typeof cache?.fromCache, 'cache.fromCache should be a boolean').toBe('boolean');
    expect(typeof cache?.ttlMs, 'cache.ttlMs should be numeric').toBe('number');
    assertIsoDateString(cache?.expiresAt, 'snapshot.cache.expiresAt');

    assertReliabilityMetadata(snapshot, 'screen_capture');
    assertReliabilityMetadata(snapshot, 'action_execution');
  } finally {
    await app.close();
  }
});

test('desktop-control bridge repeated reads keep screenshot/action checks stable', async () => {
  const { app, window } = await launchDesktopApp();

  try {
    const snapshots = [
      await readDesktopControlStatus(window, { forceRefresh: true }),
      await readDesktopControlStatus(window),
      await readDesktopControlStatus(window, { forceRefresh: true }),
    ];

    for (const [index, snapshot] of snapshots.entries()) {
      assertIsoDateString(snapshot.checkedAt, `snapshots[${index}].checkedAt`);
      expect(typeof snapshot.cache?.fromCache, `snapshots[${index}] cache.fromCache should be boolean`).toBe('boolean');
      expect(typeof snapshot.cache?.ttlMs, `snapshots[${index}] cache.ttlMs should be number`).toBe('number');
      assertIsoDateString(snapshot.cache?.expiresAt, `snapshots[${index}].cache.expiresAt`);
      assertReliabilityMetadata(snapshot, 'screen_capture');
      assertReliabilityMetadata(snapshot, 'action_execution');
    }

    for (let index = 1; index < snapshots.length; index += 1) {
      const previous = snapshots[index - 1];
      const current = snapshots[index];
      const previousTs = Date.parse(previous.checkedAt as string);
      const currentTs = Date.parse(current.checkedAt as string);

      if (current.cache?.fromCache) {
        expect(current.checkedAt, `cached snapshot at index ${index} should preserve checkedAt`).toBe(
          previous.checkedAt
        );
      } else {
        expect(
          currentTs >= previousTs,
          `uncached snapshot at index ${index} should not go backwards in time`
        ).toBe(true);
      }
    }

    const screenReasonCodes = snapshots.map((snapshot) => {
      const details = snapshot.checks?.screen_capture?.details as Record<string, unknown> | undefined;
      return details?.readinessReasonCode;
    });
    const actionReasonCodes = snapshots.map((snapshot) => {
      const details = snapshot.checks?.action_execution?.details as Record<string, unknown> | undefined;
      return details?.readinessReasonCode;
    });

    expect(new Set(screenReasonCodes).size, 'screen_capture reason code should be stable across repeated reads').toBe(1);
    expect(new Set(actionReasonCodes).size, 'action_execution reason code should be stable across repeated reads').toBe(1);
  } finally {
    await app.close();
  }
});
