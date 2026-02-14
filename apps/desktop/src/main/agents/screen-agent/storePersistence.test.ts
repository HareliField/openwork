import { describe, expect, it, vi } from 'vitest';

const appSettingsMocks = vi.hoisted(() => ({
  recordScreenAgentStartup: vi.fn(),
  recordScreenAgentRestart: vi.fn(),
}));

vi.mock('../../store/appSettings', () => ({
  recordScreenAgentStartup: appSettingsMocks.recordScreenAgentStartup,
  recordScreenAgentRestart: appSettingsMocks.recordScreenAgentRestart,
}));

import { createScreenAgentLifecycleStorePersistence } from './storePersistence';

describe('createScreenAgentLifecycleStorePersistence', () => {
  it('maps startup persistence to lifecycle counters', () => {
    appSettingsMocks.recordScreenAgentStartup.mockReturnValue({
      startupCount: 3,
      restartCount: 1,
    });

    const persistence = createScreenAgentLifecycleStorePersistence();
    const result = persistence.onStartup?.('run-1', '2026-01-01T00:00:00.000Z');

    expect(appSettingsMocks.recordScreenAgentStartup).toHaveBeenCalledWith(
      'run-1',
      '2026-01-01T00:00:00.000Z'
    );
    expect(result).toEqual({
      startupCount: 3,
      restartCount: 1,
    });
  });

  it('maps restart persistence to lifecycle counters', () => {
    appSettingsMocks.recordScreenAgentRestart.mockReturnValue({
      startupCount: 3,
      restartCount: 2,
    });

    const persistence = createScreenAgentLifecycleStorePersistence();
    const result = persistence.onRestart?.(
      'run-1',
      'restart-token',
      '2026-01-01T00:01:00.000Z'
    );

    expect(appSettingsMocks.recordScreenAgentRestart).toHaveBeenCalledWith(
      'run-1',
      'restart-token',
      '2026-01-01T00:01:00.000Z'
    );
    expect(result).toEqual({
      startupCount: 3,
      restartCount: 2,
    });
  });
});
