import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateDesktopControlReadiness } from './readiness';

interface SkillLayoutOptions {
  includeScreenCapture?: boolean;
  includeActionExecutor?: boolean;
  includeFilePermission?: boolean;
  includeLiveScreenStream?: boolean;
}

function createSkillsDirectory(baseDir: string, options: SkillLayoutOptions = {}): string {
  const includeScreenCapture = options.includeScreenCapture ?? true;
  const includeActionExecutor = options.includeActionExecutor ?? true;
  const includeFilePermission = options.includeFilePermission ?? true;
  const includeLiveScreenStream = options.includeLiveScreenStream ?? true;
  const skillsPath = path.join(baseDir, 'skills');

  const files: Array<{ enabled: boolean; filePath: string }> = [
    {
      enabled: includeScreenCapture,
      filePath: path.join(skillsPath, 'screen-capture', 'src', 'index.ts'),
    },
    {
      enabled: includeActionExecutor,
      filePath: path.join(skillsPath, 'action-executor', 'src', 'index.ts'),
    },
    {
      enabled: includeFilePermission,
      filePath: path.join(skillsPath, 'file-permission', 'src', 'index.ts'),
    },
    {
      enabled: includeLiveScreenStream,
      filePath: path.join(skillsPath, 'live-screen-stream', 'src', 'index.ts'),
    },
  ];

  for (const file of files) {
    if (!file.enabled) continue;
    fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
    fs.writeFileSync(file.filePath, '// readiness test fixture');
  }

  return skillsPath;
}

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-control-readiness-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('DesktopControlReadiness evaluator', () => {
  it('returns unavailable with reason code when screen capture permission is denied', async () => {
    const tempDir = createTempDir();
    const skillsPath = createSkillsDirectory(tempDir);

    const readiness = await evaluateDesktopControlReadiness({
      dependencies: {
        platform: 'darwin',
        getScreenMediaAccessStatus: () => 'denied',
        isAccessibilityTrusted: () => true,
        getSkillsPath: () => skillsPath,
        getNpxPath: () => 'npx',
        fileExists: (targetPath) => fs.existsSync(targetPath),
      },
    });

    expect(readiness.checks.screen_capture.state).toBe('unavailable');
    expect(readiness.checks.screen_capture.reasonCode).toBe('screen_capture_permission_denied');
    expect(readiness.checks.action_execution.state).toBe('ok');
    expect(readiness.checks.mcp_health.state).toBe('ok');
  });

  it('returns degraded with reason code when support runtime entrypoint is missing', async () => {
    const tempDir = createTempDir();
    const skillsPath = createSkillsDirectory(tempDir, { includeFilePermission: false });

    const readiness = await evaluateDesktopControlReadiness({
      dependencies: {
        platform: 'darwin',
        getScreenMediaAccessStatus: () => 'granted',
        isAccessibilityTrusted: () => true,
        getSkillsPath: () => skillsPath,
        getNpxPath: () => 'npx',
        fileExists: (targetPath) => fs.existsSync(targetPath),
      },
    });

    expect(readiness.checks.mcp_health.state).toBe('degraded');
    expect(readiness.checks.mcp_health.reasonCode).toBe('runtime_health_missing_support_entrypoints');
    expect(readiness.checks.screen_capture.state).toBe('ok');
    expect(readiness.checks.action_execution.state).toBe('ok');
  });

  it('returns ok for all capabilities when permissions and runtime are healthy', async () => {
    const tempDir = createTempDir();
    const skillsPath = createSkillsDirectory(tempDir);

    const readiness = await evaluateDesktopControlReadiness({
      dependencies: {
        platform: 'darwin',
        getScreenMediaAccessStatus: () => 'granted',
        isAccessibilityTrusted: () => true,
        getSkillsPath: () => skillsPath,
        getNpxPath: () => 'npx',
        fileExists: (targetPath) => fs.existsSync(targetPath),
      },
    });

    expect(readiness.checks.screen_capture.state).toBe('ok');
    expect(readiness.checks.screen_capture.reasonCode).toBe('screen_capture_ok');
    expect(readiness.checks.action_execution.state).toBe('ok');
    expect(readiness.checks.action_execution.reasonCode).toBe('action_execution_ok');
    expect(readiness.checks.mcp_health.state).toBe('ok');
    expect(readiness.checks.mcp_health.reasonCode).toBe('runtime_health_ok');
  });

  it('uses deterministic timeout/retry policy before returning degraded', async () => {
    const tempDir = createTempDir();
    const skillsPath = createSkillsDirectory(tempDir);

    const readiness = await evaluateDesktopControlReadiness({
      retryPolicy: {
        screen_capture: {
          timeoutMs: 10,
          maxAttempts: 3,
        },
      },
      dependencies: {
        platform: 'darwin',
        getScreenMediaAccessStatus: async () => await new Promise<string>(() => {}),
        isAccessibilityTrusted: () => true,
        getSkillsPath: () => skillsPath,
        getNpxPath: () => 'npx',
        fileExists: (targetPath) => fs.existsSync(targetPath),
      },
    });

    expect(readiness.checks.screen_capture.state).toBe('degraded');
    expect(readiness.checks.screen_capture.reasonCode).toBe('screen_capture_probe_timeout');
    expect(readiness.checks.screen_capture.attempts).toHaveLength(3);
    expect(readiness.checks.screen_capture.attempts.map((attempt) => attempt.attempt)).toEqual([
      1, 2, 3,
    ]);
    expect(readiness.checks.screen_capture.attempts.every((attempt) => attempt.outcome === 'timeout')).toBe(true);
  });
});
