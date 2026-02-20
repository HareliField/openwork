/**
 * Integration tests for desktop-control preflight payloads.
 *
 * These tests exercise the real preflight module with mocked platform probes to
 * verify structured failure + recovery payloads and cache metadata behavior.
 *
 * @module __tests__/integration/main/desktop-control.preflight.integration.test
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preflightProbeState = vi.hoisted(() => ({
  screenRecordingStatus: 'granted',
  accessibilityTrusted: true,
  skillsPath: '/tmp/openwork-desktop-control-skills',
  npxPath: 'npx',
}));

vi.mock('electron', () => ({
  app: {
    isReady: vi.fn(() => true),
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/test-app'),
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => preflightProbeState.screenRecordingStatus),
    isTrustedAccessibilityClient: vi.fn(() => preflightProbeState.accessibilityTrusted),
  },
}));

vi.mock('@main/opencode/config-generator', () => ({
  getSkillsPath: vi.fn(() => preflightProbeState.skillsPath),
}));

vi.mock('@main/utils/bundled-node', () => ({
  getNpxPath: vi.fn(() => preflightProbeState.npxPath),
}));

function createMockSkillsDirectory(baseDir: string): string {
  const skillsPath = path.join(baseDir, 'skills');
  const requiredEntrypoints = [
    path.join(skillsPath, 'screen-capture', 'src', 'index.ts'),
    path.join(skillsPath, 'action-executor', 'src', 'index.ts'),
    path.join(skillsPath, 'file-permission', 'src', 'index.ts'),
    path.join(skillsPath, 'live-screen-stream', 'src', 'index.ts'),
  ];

  for (const entrypoint of requiredEntrypoints) {
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, '// integration test entrypoint');
  }

  return skillsPath;
}

function assertStructuredPayload(payload: {
  checkedAt: string;
  cache: { ttlMs: number; expiresAt: string; fromCache: boolean };
  checks: {
    screen_capture: { status: string; message: string };
    action_execution: { status: string; message: string };
    mcp_health: { status: string; message: string };
  };
}) {
  expect(payload.checkedAt).toBeTruthy();
  expect(Number.isNaN(Date.parse(payload.checkedAt))).toBe(false);
  expect(payload.cache.ttlMs).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(payload.cache.expiresAt))).toBe(false);
  expect(typeof payload.checks.screen_capture.status).toBe('string');
  expect(typeof payload.checks.action_execution.status).toBe('string');
  expect(typeof payload.checks.mcp_health.status).toBe('string');
  expect(typeof payload.checks.screen_capture.message).toBe('string');
  expect(typeof payload.checks.action_execution.message).toBe('string');
  expect(typeof payload.checks.mcp_health.message).toBe('string');
}

describe('Desktop Control Preflight Integration', () => {
  let tempDir = '';

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-control-preflight-'));
    preflightProbeState.skillsPath = createMockSkillsDirectory(tempDir);
    preflightProbeState.npxPath = 'npx';
    preflightProbeState.screenRecordingStatus = 'granted';
    preflightProbeState.accessibilityTrusted = true;
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns blocked payload with remediation when screen-recording permission is denied (failure path)', async () => {
    vi.resetModules();
    preflightProbeState.screenRecordingStatus = 'denied';
    preflightProbeState.accessibilityTrusted = true;

    const { getDesktopControlStatus } = await import('@main/desktop-control/preflight');
    const status = await getDesktopControlStatus({ forceRefresh: true });

    assertStructuredPayload(status);
    expect(status.status).toBe('needs_screen_recording_permission');
    expect(status.errorCode).toBe('screen_recording_permission_required');
    expect(status.remediation.systemSettingsPath).toContain('Screen Recording');
    expect(status.checks.screen_capture.status).toBe('blocked');
    expect(status.checks.action_execution.status).toBe('ready');
    expect(status.checks.mcp_health.status).toBe('ready');
    expect(status.cache.fromCache).toBe(false);
  });

  it('returns ready payload after permissions are available (recovery path)', async () => {
    vi.resetModules();
    preflightProbeState.screenRecordingStatus = 'granted';
    preflightProbeState.accessibilityTrusted = true;

    const { getDesktopControlStatus } = await import('@main/desktop-control/preflight');
    const status = await getDesktopControlStatus({ forceRefresh: true });

    assertStructuredPayload(status);
    expect(status.status).toBe('ready');
    expect(status.errorCode).toBeNull();
    expect(status.message.toLowerCase()).toContain('ready');
    expect(status.checks.screen_capture.status).toBe('ready');
    expect(status.checks.action_execution.status).toBe('ready');
    expect(status.checks.mcp_health.status).toBe('ready');
  });

  it('marks second call as cached when forceRefresh is not set', async () => {
    vi.resetModules();
    preflightProbeState.screenRecordingStatus = 'granted';
    preflightProbeState.accessibilityTrusted = true;

    const { getDesktopControlStatus, PREFLIGHT_CACHE_TTL_MS } = await import(
      '@main/desktop-control/preflight'
    );

    const first = await getDesktopControlStatus({ forceRefresh: true });
    const second = await getDesktopControlStatus();

    expect(first.cache.ttlMs).toBe(PREFLIGHT_CACHE_TTL_MS);
    expect(first.cache.fromCache).toBe(false);
    expect(second.cache.fromCache).toBe(true);
    expect(second.checkedAt).toBe(first.checkedAt);
  });
});
