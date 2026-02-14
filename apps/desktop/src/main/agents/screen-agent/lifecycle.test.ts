import { describe, expect, it } from 'vitest';
import type { ScreenAgentLifecycleLogEntry } from './lifecycle';
import { ScreenAgentLifecycle } from './lifecycle';

function createClock(startMs: number = Date.parse('2026-01-01T00:00:00.000Z')): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let currentMs = startMs;
  return {
    now: () => currentMs,
    advance: (ms: number) => {
      currentMs += ms;
    },
  };
}

describe('ScreenAgentLifecycle', () => {
  it('keeps startup/restart transitions idempotent for repeated tokens', () => {
    const clock = createClock();
    const lifecycle = new ScreenAgentLifecycle({
      serviceNames: ['screen-capture', 'action-executor'],
      now: clock.now,
      lateInitGraceMs: 8_000,
    });

    lifecycle.startup('boot-1');
    lifecycle.startup('boot-1');
    let snapshot = lifecycle.getSnapshot();
    expect(snapshot.startupCount).toBe(1);
    expect(snapshot.phase).toBe('starting');

    lifecycle.markServiceReady('screen-capture');
    lifecycle.markServiceReady('action-executor');
    snapshot = lifecycle.getSnapshot();
    expect(snapshot.phase).toBe('running');

    lifecycle.restart('mcp-unhealthy', 'restart-1');
    lifecycle.restart('mcp-unhealthy', 'restart-1');
    snapshot = lifecycle.getSnapshot();
    expect(snapshot.restartCount).toBe(1);
    expect(snapshot.phase).toBe('restarting');
    expect(snapshot.services.every((service) => service.status === 'pending')).toBe(true);
  });

  it('recovers deterministically when services finish initialization after restart', () => {
    const clock = createClock();
    const lifecycle = new ScreenAgentLifecycle({
      serviceNames: ['screen-capture', 'action-executor'],
      now: clock.now,
      lateInitGraceMs: 6_000,
    });

    lifecycle.startup('boot-1');
    lifecycle.markServiceReady('screen-capture');
    lifecycle.markServiceReady('action-executor');
    lifecycle.restart('manual-restart', 'restart-2');

    const firstRecheck = lifecycle.recheck();
    expect(firstRecheck.status).toBe('initializing');
    expect(firstRecheck.pendingServices).toEqual(['screen-capture', 'action-executor']);
    expect(firstRecheck.lateInitialization).toBe(true);

    clock.advance(2_000);
    lifecycle.markServiceReady('screen-capture');
    const secondRecheck = lifecycle.recheck();
    expect(secondRecheck.status).toBe('initializing');
    expect(secondRecheck.pendingServices).toEqual(['action-executor']);

    clock.advance(500);
    lifecycle.markServiceReady('action-executor');
    const thirdRecheck = lifecycle.recheck();
    expect(thirdRecheck.status).toBe('ready');
    expect(thirdRecheck.pendingServices).toEqual([]);
    expect(thirdRecheck.failedServices).toEqual([]);
    expect(thirdRecheck.snapshot.phase).toBe('running');
  });

  it('emits structured lifecycle logs', () => {
    const clock = createClock();
    const logs: ScreenAgentLifecycleLogEntry[] = [];
    const lifecycle = new ScreenAgentLifecycle({
      serviceNames: ['screen-capture'],
      now: clock.now,
      logger: (entry) => logs.push(entry),
      lateInitGraceMs: 5_000,
    });

    lifecycle.startup('boot-structured');
    lifecycle.restart('manual-restart', 'restart-structured');
    lifecycle.recheck();

    expect(logs.length).toBeGreaterThan(0);
    for (const entry of logs) {
      expect(entry.scope).toBe('screen-agent-lifecycle');
      expect(entry.event.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
      expect(entry.runId.length).toBeGreaterThan(0);
      expect(typeof entry.startupCount).toBe('number');
      expect(typeof entry.restartCount).toBe('number');
      expect(typeof entry.recheckCount).toBe('number');
    }

    const recheckLog = logs.find((entry) => entry.event === 'recheck');
    expect(recheckLog).toBeDefined();
    expect(recheckLog?.details?.status).toBe('initializing');
  });
});
