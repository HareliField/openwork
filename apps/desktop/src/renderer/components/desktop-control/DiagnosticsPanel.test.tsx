/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DesktopControlStatusPayload,
  DesktopControlStatusSnapshot,
} from '../../lib/accomplish';
import { DiagnosticsPanel } from './DiagnosticsPanel';

afterEach(() => {
  cleanup();
});

interface RawStatusSnapshot extends Omit<DesktopControlStatusSnapshot, 'status'> {
  status: string;
}

const BASE_STATUS: RawStatusSnapshot = {
  status: 'ready',
  errorCode: null,
  message: 'Desktop control is ready.',
  remediation: {
    title: 'No action needed',
    steps: ['Desktop control dependencies are ready.'],
  },
  checkedAt: '2026-02-14T01:00:00.000Z',
  cache: {
    ttlMs: 5000,
    expiresAt: '2026-02-14T01:00:05.000Z',
    fromCache: false,
  },
  checks: {
    screen_capture: {
      capability: 'screen_capture',
      status: 'ready',
      errorCode: null,
      message: 'Screen recording permission is granted.',
      remediation: {
        title: 'No action needed',
        steps: ['Desktop control dependencies are ready.'],
      },
      checkedAt: '2026-02-14T01:00:00.000Z',
    },
    action_execution: {
      capability: 'action_execution',
      status: 'ready',
      errorCode: null,
      message: 'Accessibility permission is granted.',
      remediation: {
        title: 'No action needed',
        steps: ['Desktop control dependencies are ready.'],
      },
      checkedAt: '2026-02-14T01:00:00.000Z',
    },
    mcp_health: {
      capability: 'mcp_health',
      status: 'ready',
      errorCode: null,
      message: 'MCP runtime dependencies are present.',
      remediation: {
        title: 'No action needed',
        steps: ['Desktop control dependencies are ready.'],
      },
      checkedAt: '2026-02-14T01:00:00.000Z',
    },
  },
};

function buildStatus(
  status: string,
  overrides: Partial<RawStatusSnapshot> = {}
): DesktopControlStatusPayload {
  return {
    ...BASE_STATUS,
    ...overrides,
    status,
    checks: {
      ...BASE_STATUS.checks,
      ...overrides.checks,
    },
  } as unknown as DesktopControlStatusPayload;
}

describe('DiagnosticsPanel state mapping', () => {
  it('maps ok to hidden UI when no issue is present', () => {
    render(<DiagnosticsPanel status={buildStatus('ok')} />);
    expect(screen.queryByTestId('desktop-control-diagnostics-panel')).toBeNull();
  });

  it('maps degraded readiness to actionable degraded UI', () => {
    render(<DiagnosticsPanel status={buildStatus('degraded')} />);

    expect(screen.getByTestId('desktop-control-diagnostics-panel')).toBeTruthy();
    expect(screen.getByText(/^Degraded/)).toBeTruthy();
    expect(screen.getByText(/partially ready/i)).toBeTruthy();
  });

  it('maps unavailable readiness to unavailable UI', () => {
    render(<DiagnosticsPanel status={buildStatus('unavailable')} />);

    expect(screen.getByTestId('desktop-control-diagnostics-panel')).toBeTruthy();
    expect(screen.getByText(/^Unavailable/)).toBeTruthy();
  });

  it('maps unknown readiness to unknown UI', () => {
    render(<DiagnosticsPanel status={buildStatus('unknown')} />);

    expect(screen.getByTestId('desktop-control-diagnostics-panel')).toBeTruthy();
    expect(screen.getByText(/^Unknown/)).toBeTruthy();
  });
});

describe('DiagnosticsPanel recheck behavior', () => {
  it('shows loading state while async recheck is pending', async () => {
    let resolveRecheck: (() => void) | null = null;
    const onRecheck = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRecheck = resolve;
        })
    );

    render(<DiagnosticsPanel status={buildStatus('degraded')} onRecheck={onRecheck} />);

    fireEvent.click(screen.getByRole('button', { name: /recheck/i }));

    const button = screen.getByRole('button', { name: /rechecking/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(onRecheck).toHaveBeenCalledTimes(1);

    resolveRecheck?.();
    await waitFor(() => {
      expect(screen.getByTestId('desktop-control-recheck-success')).toBeTruthy();
    });
  });

  it('shows success state when async recheck resolves', async () => {
    const onRecheck = vi.fn(async () => undefined);
    render(<DiagnosticsPanel status={buildStatus('degraded')} onRecheck={onRecheck} />);

    fireEvent.click(screen.getByRole('button', { name: /recheck/i }));

    await waitFor(() => {
      expect(screen.getByTestId('desktop-control-recheck-success')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /checked/i })).toBeTruthy();
  });

  it('shows error state when async recheck rejects', async () => {
    const onRecheck = vi.fn(async () => {
      throw new Error('Bridge timed out');
    });
    render(<DiagnosticsPanel status={buildStatus('degraded')} onRecheck={onRecheck} />);

    fireEvent.click(screen.getByRole('button', { name: /recheck/i }));

    await waitFor(() => {
      const errorEl = screen.getByTestId('desktop-control-recheck-error');
      expect(errorEl.textContent).toContain('Bridge timed out');
    });
  });
});
