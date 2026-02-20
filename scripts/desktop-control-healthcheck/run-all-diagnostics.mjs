#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
const desktopDir = resolve(repoRoot, 'apps/desktop');
const startupHealthcheckPath = resolve(__dirname, 'startup-healthcheck.mjs');
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function runStep(step) {
  return new Promise((resolveStep, rejectStep) => {
    console.log(`[desktop-control-diagnostics] ${step.name}`);

    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: {
        ...process.env,
        ...step.env,
      },
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      rejectStep(error);
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolveStep();
        return;
      }

      const exitContext =
        signal !== null ? `signal ${signal}` : `exit code ${typeof code === 'number' ? code : 'unknown'}`;
      rejectStep(new Error(`${step.name} failed with ${exitContext}.`));
    });
  });
}

async function run() {
  const steps = [
    {
      name: 'Building desktop app',
      command: pnpmCmd,
      args: ['-F', '@accomplish/desktop', 'build'],
      cwd: repoRoot,
    },
    {
      name: 'Running preload + IPC startup healthcheck',
      command: process.execPath,
      args: [startupHealthcheckPath],
      cwd: repoRoot,
    },
    {
      name: 'Running desktop-control diagnostics Playwright suite',
      command: pnpmCmd,
      args: ['--dir', desktopDir, 'exec', 'playwright', 'test', '--config', '../../tests/desktop-control/playwright.config.ts'],
      cwd: repoRoot,
      env: {
        E2E_SKIP_AUTH: process.env.E2E_SKIP_AUTH ?? '1',
        E2E_MOCK_TASK_EVENTS: process.env.E2E_MOCK_TASK_EVENTS ?? '1',
      },
    },
  ];

  for (const step of steps) {
    // Run sequentially so each diagnostic precondition is satisfied.
    // eslint-disable-next-line no-await-in-loop
    await runStep(step);
  }

  console.log('[desktop-control-diagnostics] PASS');
}

run().catch((error) => {
  console.error('[desktop-control-diagnostics] FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
