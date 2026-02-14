import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

test.describe.configure({ mode: 'serial' });

test('renderer bridge exposes desktop-control readiness API', async () => {
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

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState('load');

    const bridgeCheck = await window.evaluate(async () => {
      const api = window.accomplish as
        | {
            getDesktopControlStatus?: (options?: { forceRefresh?: boolean }) => Promise<unknown>;
            desktopControlGetStatus?: (options?: { forceRefresh?: boolean }) => Promise<unknown>;
            desktopControl?: { getStatus?: (options?: { forceRefresh?: boolean }) => Promise<unknown> };
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
            ? () => api.getDesktopControlStatus({ forceRefresh: true })
            : undefined,
        ],
        [
          'desktopControlGetStatus',
          typeof api.desktopControlGetStatus === 'function'
            ? () => api.desktopControlGetStatus({ forceRefresh: true })
            : undefined,
        ],
        [
          'desktopControl.getStatus',
          typeof api.desktopControl === 'object' &&
          api.desktopControl !== null &&
          typeof api.desktopControl.getStatus === 'function'
            ? () => api.desktopControl!.getStatus!({ forceRefresh: true })
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

        const status = (payload as { status?: unknown }).status;
        const checks = (payload as { checks?: unknown }).checks;

        if (typeof status !== 'string') {
          return {
            ok: false,
            reason: `Readiness API ${method} returned payload without string status`,
            details: payload,
          };
        }

        if (!checks || typeof checks !== 'object') {
          return {
            ok: false,
            reason: `Readiness API ${method} returned payload without checks object`,
            details: payload,
          };
        }

        return {
          ok: true,
          method,
          status,
          checkKeys: Object.keys(checks as Record<string, unknown>),
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
    });

    expect(bridgeCheck, JSON.stringify(bridgeCheck, null, 2)).toMatchObject({ ok: true });

    if (bridgeCheck.ok) {
      expect(typeof bridgeCheck.status).toBe('string');
      expect(bridgeCheck.status.length).toBeGreaterThan(0);
      expect(bridgeCheck.checkKeys).toEqual(
        expect.arrayContaining(['screen_capture', 'action_execution', 'mcp_health'])
      );
    }
  } finally {
    await app.close();
  }
});
