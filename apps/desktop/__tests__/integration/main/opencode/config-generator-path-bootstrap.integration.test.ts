import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tempUserDataDir: string;
let tempAppDir: string;
let tempResourcesDir: string;

const originalPlatform = process.platform;

const mockApp = {
  isPackaged: false,
  getAppPath: vi.fn(() => tempAppDir),
  getPath: vi.fn((name: string) => {
    if (name === 'userData') {
      return tempUserDataDir;
    }
    return path.join(tempUserDataDir, name);
  }),
};

vi.mock('electron', () => ({
  app: mockApp,
}));

vi.mock('@main/permission-api', () => ({
  PERMISSION_API_PORT: 9999,
}));

function createBundledNodeTree(resourcesPath: string): string {
  const bundledBinDir = path.join(resourcesPath, 'nodejs', process.arch, 'bin');
  fs.mkdirSync(bundledBinDir, { recursive: true });
  fs.writeFileSync(path.join(bundledBinDir, 'node'), '');
  fs.writeFileSync(path.join(bundledBinDir, 'npm'), '');
  fs.writeFileSync(path.join(bundledBinDir, 'npx'), '');
  return bundledBinDir;
}

describe('OpenCode Config Generator PATH Bootstrap Integration', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    originalEnv = { ...process.env };
    process.env = { ...originalEnv };

    mockApp.isPackaged = false;

    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-path-userData-'));
    tempAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-path-app-'));
    tempResourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-path-resources-'));

    const skillsDir = path.join(tempAppDir, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'file-permission', 'src'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'screen-capture', 'src'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'live-screen-stream', 'src'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'action-executor', 'src'), { recursive: true });

    mockApp.getAppPath.mockReturnValue(tempAppDir);
    mockApp.getPath.mockImplementation((name: string) => {
      if (name === 'userData') {
        return tempUserDataDir;
      }
      return path.join(tempUserDataDir, name);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    Object.defineProperty(process, 'platform', { value: originalPlatform });

    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
      fs.rmSync(tempAppDir, { recursive: true, force: true });
      fs.rmSync(tempResourcesDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it('keeps bundled node first and injects required POSIX system paths', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockApp.isPackaged = true;
    const bundledBinDir = createBundledNodeTree(tempResourcesDir);
    (process as NodeJS.Process & { resourcesPath: string }).resourcesPath = tempResourcesDir;
    process.env.PATH = '/custom/tools:/opt/homebrew/bin';

    const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
    const configPath = await generateOpenCodeConfig();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    const envPath = config.mcp['screen-capture'].environment.PATH as string;
    const pathParts = envPath.split(':');

    expect(pathParts[0]).toBe(bundledBinDir);
    expect(pathParts).toContain('/usr/bin');
    expect(pathParts).toContain('/bin');
    expect(pathParts).toContain('/usr/sbin');
    expect(pathParts).toContain('/sbin');
    expect(pathParts).toContain('/custom/tools');
    expect(pathParts).toContain('/opt/homebrew/bin');
  });

  it('deduplicates PATH entries during runtime config generation', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/bin:/custom/bin';

    const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
    const configPath = await generateOpenCodeConfig();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    const envPath = config.mcp['screen-capture'].environment.PATH as string;
    const pathParts = envPath.split(':');
    const usrBinCount = pathParts.filter((entry) => entry === '/usr/bin').length;

    expect(usrBinCount).toBe(1);
    expect(pathParts).toContain('/custom/bin');
  });

  it('uses Windows PATH delimiter and avoids POSIX bootstrap paths on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = 'C:\\Windows\\System32;C:\\Tools;C:\\Windows\\System32';
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

    const { generateOpenCodeConfig } = await import('@main/opencode/config-generator');
    const configPath = await generateOpenCodeConfig();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    const env = config.mcp['screen-capture'].environment as Record<string, string>;
    const pathParts = env.PATH.split(';');

    expect(pathParts).toContain('C:\\Windows\\System32');
    expect(pathParts).toContain('C:\\Tools');
    expect(pathParts.filter((entry) => entry === 'C:\\Windows\\System32').length).toBe(1);
    expect(env.PATH).not.toContain('/usr/bin');
    expect(env.PATH).not.toContain('/bin');
    expect(env.SHELL).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});
