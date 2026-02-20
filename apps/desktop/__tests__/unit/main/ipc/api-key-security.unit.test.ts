import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, Function>();

const mockTaskManager = {
  startTask: vi.fn(),
  cancelTask: vi.fn(),
  interruptTask: vi.fn(),
  sendResponse: vi.fn(),
  hasActiveTask: vi.fn(() => false),
  getActiveTaskId: vi.fn(() => null),
  getSessionId: vi.fn(() => null),
  isTaskQueued: vi.fn(() => false),
  cancelQueuedTask: vi.fn(),
};

let mockApiKeys: Record<string, string | null> = {};

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      registeredHandlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn((channel: string) => {
      registeredHandlers.delete(channel);
    }),
    removeAllListeners: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({
      id: 1,
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: vi.fn(),
      },
    })),
    getFocusedWindow: vi.fn(() => ({
      id: 1,
      isDestroyed: () => false,
    })),
    getAllWindows: vi.fn(() => [{ id: 1 }]),
  },
  shell: {
    openExternal: vi.fn(),
  },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/test-app'),
  },
}));

vi.mock('@main/opencode/adapter', () => ({
  isOpenCodeCliInstalled: vi.fn(async () => true),
  getOpenCodeCliVersion: vi.fn(async () => '1.0.0'),
}));

vi.mock('@main/opencode/task-manager', () => ({
  getTaskManager: vi.fn(() => mockTaskManager),
}));

vi.mock('@main/store/secureStorage', () => ({
  storeApiKey: vi.fn((provider: string, key: string) => {
    mockApiKeys[provider] = key;
  }),
  getApiKey: vi.fn((provider: string) => mockApiKeys[provider] ?? null),
  deleteApiKey: vi.fn((provider: string) => {
    delete mockApiKeys[provider];
  }),
  getAllApiKeys: vi.fn(async () => ({
    anthropic: mockApiKeys['anthropic'] ?? null,
    openai: mockApiKeys['openai'] ?? null,
    google: mockApiKeys['google'] ?? null,
    xai: mockApiKeys['xai'] ?? null,
    openrouter: mockApiKeys['openrouter'] ?? null,
    custom: mockApiKeys['custom'] ?? null,
  })),
  hasAnyApiKey: vi.fn(async () => Object.values(mockApiKeys).some((value) => Boolean(value))),
  listStoredCredentials: vi.fn(async () => []),
}));

vi.mock('@main/store/appSettings', () => ({
  getDebugMode: vi.fn(() => false),
  setDebugMode: vi.fn(),
  getAppSettings: vi.fn(() => ({ debugMode: false, onboardingComplete: false })),
  getOnboardingComplete: vi.fn(() => false),
  setOnboardingComplete: vi.fn(),
  getSelectedModel: vi.fn(() => null),
  setSelectedModel: vi.fn(),
  getOllamaConfig: vi.fn(() => null),
  setOllamaConfig: vi.fn(),
}));

vi.mock('@main/permission-api', () => ({
  startPermissionApiServer: vi.fn(),
  initPermissionApi: vi.fn(),
  resolvePermission: vi.fn(() => false),
  isFilePermissionRequest: vi.fn((requestId: string) => requestId.startsWith('filereq_')),
}));

vi.mock('@main/desktop-control/preflight', () => ({
  getDesktopControlStatus: vi.fn(async () => ({
    status: 'healthy',
    remediation: {
      message: 'ok',
      actions: [],
    },
    cache: {
      ageMs: 0,
      source: 'fresh',
    },
    checks: {
      screen_capture: { status: 'healthy', detail: 'ok' },
      action_execution: { status: 'healthy', detail: 'ok' },
      mcp_health: { status: 'healthy', detail: 'ok' },
    },
  })),
}));

import { registerIPCHandlers } from '@main/ipc/handlers';

async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = registeredHandlers.get(channel);
  if (!handler) {
    throw new Error(`Missing handler for channel: ${channel}`);
  }

  const event = {
    sender: {
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
  };

  return handler(event, ...args);
}

describe('IPC API Key Security Regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    mockApiKeys = {};
    registerIPCHandlers();
  });

  it('api-key:get returns masked metadata only', async () => {
    const rawKey = 'sk-ant-top-secret-value';
    mockApiKeys['anthropic'] = rawKey;

    const result = (await invokeHandler('api-key:get')) as { exists: boolean; prefix?: string };

    expect(result).toEqual({
      exists: true,
      prefix: `${rawKey.substring(0, 8)}...`,
    });
    expect(JSON.stringify(result)).not.toContain(rawKey);
  });

  it('api-key:get returns existence-only metadata when unset', async () => {
    delete mockApiKeys['anthropic'];

    const result = await invokeHandler('api-key:get');

    expect(result).toEqual({ exists: false });
  });

  it('api-keys:all masks all providers and never returns raw secret material', async () => {
    const anthropicKey = 'sk-ant-sensitive-123';
    const openAiKey = 'sk-openai-sensitive-456';
    const googleKey = 'AIza-sensitive-789';
    mockApiKeys = {
      anthropic: anthropicKey,
      openai: openAiKey,
      google: googleKey,
      xai: null,
      openrouter: null,
      custom: null,
    };

    const result = (await invokeHandler('api-keys:all')) as Record<
      string,
      { exists: boolean; prefix?: string }
    >;

    expect(result['anthropic']).toEqual({
      exists: true,
      prefix: `${anthropicKey.substring(0, 8)}...`,
    });
    expect(result['openai']).toEqual({
      exists: true,
      prefix: `${openAiKey.substring(0, 8)}...`,
    });
    expect(result['google']).toEqual({
      exists: true,
      prefix: `${googleKey.substring(0, 8)}...`,
    });
    expect(result['xai']).toEqual({ exists: false });
    expect(result['openrouter']).toEqual({ exists: false });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(anthropicKey);
    expect(serialized).not.toContain(openAiKey);
    expect(serialized).not.toContain(googleKey);
  });
});
