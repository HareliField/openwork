import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

test.describe.configure({ mode: 'serial' });

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
    const window = await getRendererWindow(app);

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

test('renderer bridge forceRefresh bypasses cached desktop-control snapshots', async () => {
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
    const window = await getRendererWindow(app);

    const cacheCheck = await window.evaluate(async () => {
      type DesktopControlPayload = {
        status?: unknown;
        checks?: unknown;
        cache?: {
          fromCache?: unknown;
          ttlMs?: unknown;
        };
      };

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

      const [method] = selected;
      const invoke = async (options?: { forceRefresh?: boolean }) => {
        if (method === 'getDesktopControlStatus') {
          return await api.getDesktopControlStatus!(options);
        }
        if (method === 'desktopControlGetStatus') {
          return await api.desktopControlGetStatus!(options);
        }
        return await api.desktopControl!.getStatus!(options);
      };

      try {
        const first = (await invoke({ forceRefresh: true })) as DesktopControlPayload;
        const second = (await invoke()) as DesktopControlPayload;
        const third = (await invoke({ forceRefresh: true })) as DesktopControlPayload;

        if (
          !first ||
          typeof first !== 'object' ||
          !second ||
          typeof second !== 'object' ||
          !third ||
          typeof third !== 'object'
        ) {
          return {
            ok: false,
            reason: `Readiness API ${method} returned malformed payload while checking cache behavior`,
          };
        }

        if (typeof first.status !== 'string' || typeof third.status !== 'string') {
          return {
            ok: false,
            reason: `Readiness API ${method} returned payload without status while checking cache behavior`,
          };
        }

        if (!first.checks || !third.checks) {
          return {
            ok: false,
            reason: `Readiness API ${method} returned payload without checks while checking cache behavior`,
          };
        }

        const firstFromCache = first.cache?.fromCache;
        const secondFromCache = second.cache?.fromCache;
        const thirdFromCache = third.cache?.fromCache;

        if (
          typeof firstFromCache !== 'boolean' ||
          typeof secondFromCache !== 'boolean' ||
          typeof thirdFromCache !== 'boolean'
        ) {
          return {
            ok: false,
            reason: `Readiness API ${method} returned payload without cache.fromCache booleans`,
            details: {
              firstFromCache,
              secondFromCache,
              thirdFromCache,
            },
          };
        }

        return {
          ok: true,
          method,
          status: third.status,
          checkKeys: Object.keys(third.checks as Record<string, unknown>),
          firstFromCache,
          secondFromCache,
          thirdFromCache,
          ttlMs: third.cache?.ttlMs,
        };
      } catch (error) {
        return {
          ok: false,
          reason: `Readiness API ${method} threw during cache verification`,
          details: {
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    });

    expect(cacheCheck, JSON.stringify(cacheCheck, null, 2)).toMatchObject({ ok: true });

    if (cacheCheck.ok) {
      expect(cacheCheck.firstFromCache).toBe(false);
      expect(cacheCheck.secondFromCache).toBe(true);
      expect(cacheCheck.thirdFromCache).toBe(false);
      expect(cacheCheck.checkKeys).toEqual(
        expect.arrayContaining(['screen_capture', 'action_execution', 'mcp_health'])
      );
    }
  } finally {
    await app.close();
  }
});
