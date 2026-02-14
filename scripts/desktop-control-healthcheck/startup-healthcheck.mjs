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

    const requiredChecks = ['screen_capture', 'action_execution', 'mcp_health'];
    const missingChecks = requiredChecks.filter(
      (key) => !(result.readinessChecks || []).includes(key)
    );

    if (missingChecks.length > 0) {
      reportFailure('Readiness payload is missing required capability checks.', {
        missingChecks,
        readinessChecks: result.readinessChecks,
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
        },
        null,
        2
      )
    );
  } finally {
    await app.close();
  }
}

run().catch((error) => {
  reportFailure('Unexpected healthcheck execution error.', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
