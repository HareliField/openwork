import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopControlStatusSnapshot } from '../../../../../src/shared/contracts/desktopControlBridge';
import {
  DESKTOP_CONTROL_BRIDGE_CHANNELS,
  DESKTOP_CONTROL_BRIDGE_ERROR_CODES,
} from '../../../../../src/shared/contracts/desktopControlBridge';

const mockExposeInMainWorld = vi.fn();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockSend = vi.fn();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    send: mockSend,
  },
}));

interface DesktopControlBridgeSurface {
  getDesktopControlStatus(options?: { forceRefresh?: boolean }): Promise<DesktopControlStatusSnapshot>;
  desktopControlGetStatus(options?: { forceRefresh?: boolean }): Promise<DesktopControlStatusSnapshot>;
  desktopControl: {
    getStatus(options?: { forceRefresh?: boolean }): Promise<DesktopControlStatusSnapshot>;
  };
}

function createReadySnapshot(): DesktopControlStatusSnapshot {
  const checkedAt = new Date().toISOString();
  const remediation = {
    title: 'No action needed',
    steps: ['Desktop control dependencies are ready.'],
  };

  return {
    status: 'ready',
    errorCode: null,
    message: 'Desktop control is ready.',
    remediation,
    checkedAt,
    cache: {
      ttlMs: 5000,
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      fromCache: false,
    },
    checks: {
      screen_capture: {
        capability: 'screen_capture',
        status: 'ready',
        errorCode: null,
        message: 'Screen recording permission is granted.',
        remediation,
        checkedAt,
      },
      action_execution: {
        capability: 'action_execution',
        status: 'ready',
        errorCode: null,
        message: 'Accessibility permission is granted.',
        remediation,
        checkedAt,
      },
      mcp_health: {
        capability: 'mcp_health',
        status: 'ready',
        errorCode: null,
        message: 'MCP runtime dependencies are present.',
        remediation,
        checkedAt,
      },
    },
  };
}

describe('desktopControl preload bridge', () => {
  let bridge: DesktopControlBridgeSurface;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(createReadySnapshot());

    mockExposeInMainWorld.mockImplementation((key: string, value: unknown) => {
      if (key === 'accomplish') {
        bridge = value as DesktopControlBridgeSurface;
      }
    });

    vi.resetModules();
    await import('../../../src/preload/index');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exposes canonical and compatibility desktop-control methods', () => {
    expect(typeof bridge.getDesktopControlStatus).toBe('function');
    expect(typeof bridge.desktopControlGetStatus).toBe('function');
    expect(typeof bridge.desktopControl.getStatus).toBe('function');
  });

  it('invokes desktop-control readiness over the canonical IPC channel', async () => {
    const options = { forceRefresh: true };

    await bridge.getDesktopControlStatus(options);
    await bridge.desktopControlGetStatus(options);
    await bridge.desktopControl.getStatus(options);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, DESKTOP_CONTROL_BRIDGE_CHANNELS.getStatus, options);
    expect(mockInvoke).toHaveBeenNthCalledWith(2, DESKTOP_CONTROL_BRIDGE_CHANNELS.getStatus, options);
    expect(mockInvoke).toHaveBeenNthCalledWith(3, DESKTOP_CONTROL_BRIDGE_CHANNELS.getStatus, options);
  });

  it('returns a structured fallback snapshot when desktop-control IPC invoke fails', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('desktop control IPC offline'));

    const snapshot = await bridge.getDesktopControlStatus({ forceRefresh: true });

    expect(snapshot.status).toBe('unknown');
    expect(snapshot.errorCode).toBe(DESKTOP_CONTROL_BRIDGE_ERROR_CODES.ipcInvokeFailed);
    expect(snapshot.message).toContain('IPC');
    expect(snapshot.checks.screen_capture.errorCode).toBe(
      DESKTOP_CONTROL_BRIDGE_ERROR_CODES.ipcInvokeFailed
    );
    expect(snapshot.checks.action_execution.errorCode).toBe(
      DESKTOP_CONTROL_BRIDGE_ERROR_CODES.ipcInvokeFailed
    );
    expect(snapshot.checks.mcp_health.errorCode).toBe(
      DESKTOP_CONTROL_BRIDGE_ERROR_CODES.ipcInvokeFailed
    );
    expect(snapshot.checks.mcp_health.details).toEqual(
      expect.objectContaining({ cause: 'desktop control IPC offline' })
    );
  });
});
