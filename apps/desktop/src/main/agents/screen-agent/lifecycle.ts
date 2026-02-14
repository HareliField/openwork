export type ScreenAgentLifecyclePhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'degraded';

export type ScreenAgentServiceStatus = 'pending' | 'ready' | 'failed';

export type ScreenAgentRecheckStatus = 'ready' | 'initializing' | 'blocked';

export interface ScreenAgentServiceSnapshot {
  name: string;
  status: ScreenAgentServiceStatus;
  updatedAt: string;
  detail: string | null;
}

export interface ScreenAgentLifecycleSnapshot {
  runId: string;
  phase: ScreenAgentLifecyclePhase;
  startupCount: number;
  restartCount: number;
  recheckCount: number;
  lastTransitionAt: string;
  lastTransitionReason: string;
  lateInitGraceMs: number;
  services: ScreenAgentServiceSnapshot[];
}

export interface ScreenAgentRecheckResult {
  status: ScreenAgentRecheckStatus;
  reason: string;
  checkedAt: string;
  pendingServices: string[];
  failedServices: string[];
  lateInitialization: boolean;
  snapshot: ScreenAgentLifecycleSnapshot;
}

export interface ScreenAgentLifecycleLogEntry {
  scope: 'screen-agent-lifecycle';
  event: string;
  timestamp: string;
  runId: string;
  phase: ScreenAgentLifecyclePhase;
  startupCount: number;
  restartCount: number;
  recheckCount: number;
  details?: Record<string, unknown>;
}

export interface ScreenAgentLifecyclePersistenceResult {
  startupCount?: number;
  restartCount?: number;
}

export interface ScreenAgentLifecyclePersistence {
  onStartup?: (
    runId: string,
    startedAt: string
  ) => ScreenAgentLifecyclePersistenceResult | void;
  onRestart?: (
    runId: string,
    restartToken: string,
    restartedAt: string
  ) => ScreenAgentLifecyclePersistenceResult | void;
}

interface ServiceState {
  status: ScreenAgentServiceStatus;
  updatedAtMs: number;
  detail: string | null;
}

interface ScreenAgentLifecycleOptions {
  serviceNames: string[];
  lateInitGraceMs?: number;
  now?: () => number;
  logger?: (entry: ScreenAgentLifecycleLogEntry) => void;
  persistence?: ScreenAgentLifecyclePersistence;
}

const DEFAULT_LATE_INIT_GRACE_MS = 12_000;

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function defaultLogger(entry: ScreenAgentLifecycleLogEntry): void {
  console.log('[ScreenAgentLifecycle]', JSON.stringify(entry));
}

export class ScreenAgentLifecycle {
  private readonly serviceNames: string[];
  private readonly services = new Map<string, ServiceState>();
  private readonly now: () => number;
  private readonly lateInitGraceMs: number;
  private readonly logger: (entry: ScreenAgentLifecycleLogEntry) => void;
  private readonly persistence: ScreenAgentLifecyclePersistence;
  private runSequence = 0;
  private startupToken: string | null = null;
  private restartToken: string | null = null;

  private state: {
    runId: string;
    phase: ScreenAgentLifecyclePhase;
    startupCount: number;
    restartCount: number;
    recheckCount: number;
    lastTransitionAtMs: number;
    lastTransitionReason: string;
  };

  constructor(options: ScreenAgentLifecycleOptions) {
    if (!Array.isArray(options.serviceNames) || options.serviceNames.length === 0) {
      throw new Error('ScreenAgentLifecycle requires at least one service name');
    }

    this.serviceNames = Array.from(new Set(options.serviceNames));
    this.now = options.now ?? (() => Date.now());
    this.lateInitGraceMs = Math.max(0, options.lateInitGraceMs ?? DEFAULT_LATE_INIT_GRACE_MS);
    this.logger = options.logger ?? defaultLogger;
    this.persistence = options.persistence ?? {};

    const nowMs = this.now();
    this.state = {
      runId: this.buildRunId(nowMs),
      phase: 'idle',
      startupCount: 0,
      restartCount: 0,
      recheckCount: 0,
      lastTransitionAtMs: nowMs,
      lastTransitionReason: 'not-started',
    };

    for (const name of this.serviceNames) {
      this.services.set(name, {
        status: 'pending',
        updatedAtMs: nowMs,
        detail: 'awaiting-startup',
      });
    }
  }

  startup(startupToken: string = 'startup'): ScreenAgentLifecycleSnapshot {
    const nowMs = this.now();
    if (
      startupToken === this.startupToken &&
      (this.state.phase === 'starting' || this.state.phase === 'running')
    ) {
      this.logEvent('startup-idempotent', { startupToken });
      return this.getSnapshot();
    }

    if (this.state.phase !== 'idle') {
      this.state.runId = this.buildRunId(nowMs);
    }

    this.startupToken = startupToken;
    this.restartToken = null;
    this.state.phase = 'starting';
    this.state.startupCount += 1;
    this.state.lastTransitionAtMs = nowMs;
    this.state.lastTransitionReason = 'startup';
    this.markAllServicesPending(nowMs, 'startup');

    const persisted = this.persistence.onStartup?.(this.state.runId, toIso(nowMs));
    if (persisted?.startupCount !== undefined) {
      this.state.startupCount = persisted.startupCount;
    }
    if (persisted?.restartCount !== undefined) {
      this.state.restartCount = persisted.restartCount;
    }

    this.logEvent('startup', { startupToken });
    return this.getSnapshot();
  }

  restart(reason: string, restartToken?: string): ScreenAgentLifecycleSnapshot {
    const nowMs = this.now();
    const token = restartToken || `restart:${reason || 'unspecified'}`;
    if (token === this.restartToken && this.state.phase === 'restarting') {
      this.logEvent('restart-idempotent', { restartToken: token, reason });
      return this.getSnapshot();
    }

    this.restartToken = token;
    this.startupToken = null;
    this.state.phase = 'restarting';
    this.state.restartCount += 1;
    this.state.lastTransitionAtMs = nowMs;
    this.state.lastTransitionReason = reason || 'restart';
    this.markAllServicesPending(nowMs, `restart:${reason || 'unspecified'}`);

    const persisted = this.persistence.onRestart?.(this.state.runId, token, toIso(nowMs));
    if (persisted?.startupCount !== undefined) {
      this.state.startupCount = persisted.startupCount;
    }
    if (persisted?.restartCount !== undefined) {
      this.state.restartCount = persisted.restartCount;
    }

    this.logEvent('restart', { restartToken: token, reason });
    return this.getSnapshot();
  }

  markServiceReady(serviceName: string, detail: string | null = null): ScreenAgentLifecycleSnapshot {
    const nowMs = this.now();
    const service = this.services.get(serviceName);
    if (!service) {
      this.logEvent('service-ready-ignored', { serviceName });
      return this.getSnapshot();
    }

    service.status = 'ready';
    service.updatedAtMs = nowMs;
    service.detail = detail;

    if (this.areAllServicesReady()) {
      this.state.phase = 'running';
      this.state.lastTransitionAtMs = nowMs;
      this.state.lastTransitionReason = 'all-services-ready';
    }

    this.logEvent('service-ready', { serviceName, detail });
    return this.getSnapshot();
  }

  markServiceFailed(serviceName: string, detail: string | null = null): ScreenAgentLifecycleSnapshot {
    const nowMs = this.now();
    const service = this.services.get(serviceName);
    if (!service) {
      this.logEvent('service-failed-ignored', { serviceName });
      return this.getSnapshot();
    }

    service.status = 'failed';
    service.updatedAtMs = nowMs;
    service.detail = detail;
    this.state.phase = 'degraded';
    this.state.lastTransitionAtMs = nowMs;
    this.state.lastTransitionReason = `service-failed:${serviceName}`;

    this.logEvent('service-failed', { serviceName, detail });
    return this.getSnapshot();
  }

  recheck(): ScreenAgentRecheckResult {
    const nowMs = this.now();
    this.state.recheckCount += 1;

    const pendingServices = this.serviceNames.filter((name) => this.services.get(name)?.status === 'pending');
    const failedServices = this.serviceNames.filter((name) => this.services.get(name)?.status === 'failed');

    let status: ScreenAgentRecheckStatus;
    let reason: string;
    let lateInitialization = false;

    if (failedServices.length > 0) {
      status = 'blocked';
      reason = 'failed-services';
    } else if (pendingServices.length === 0) {
      status = 'ready';
      reason = 'all-services-ready';
      if (this.state.phase !== 'running') {
        this.state.phase = 'running';
        this.state.lastTransitionAtMs = nowMs;
        this.state.lastTransitionReason = 'recheck-ready';
      }
    } else {
      const elapsedSinceTransition = nowMs - this.state.lastTransitionAtMs;
      lateInitialization =
        (this.state.phase === 'starting' || this.state.phase === 'restarting') &&
        elapsedSinceTransition <= this.lateInitGraceMs;

      if (lateInitialization) {
        status = 'initializing';
        reason = 'waiting-for-late-service-initialization';
      } else {
        status = 'blocked';
        reason = 'services-not-ready-after-grace-window';
      }
    }

    const result: ScreenAgentRecheckResult = {
      status,
      reason,
      checkedAt: toIso(nowMs),
      pendingServices,
      failedServices,
      lateInitialization,
      snapshot: this.getSnapshot(),
    };

    this.logEvent('recheck', {
      status,
      reason,
      pendingServices,
      failedServices,
      lateInitialization,
    });

    return result;
  }

  getSnapshot(): ScreenAgentLifecycleSnapshot {
    return {
      runId: this.state.runId,
      phase: this.state.phase,
      startupCount: this.state.startupCount,
      restartCount: this.state.restartCount,
      recheckCount: this.state.recheckCount,
      lastTransitionAt: toIso(this.state.lastTransitionAtMs),
      lastTransitionReason: this.state.lastTransitionReason,
      lateInitGraceMs: this.lateInitGraceMs,
      services: this.serviceNames.map((name) => {
        const service = this.services.get(name);
        if (!service) {
          return {
            name,
            status: 'pending' as const,
            updatedAt: toIso(this.state.lastTransitionAtMs),
            detail: 'service-missing',
          };
        }

        return {
          name,
          status: service.status,
          updatedAt: toIso(service.updatedAtMs),
          detail: service.detail,
        };
      }),
    };
  }

  private markAllServicesPending(nowMs: number, detail: string): void {
    for (const service of this.services.values()) {
      service.status = 'pending';
      service.updatedAtMs = nowMs;
      service.detail = detail;
    }
  }

  private areAllServicesReady(): boolean {
    for (const name of this.serviceNames) {
      if (this.services.get(name)?.status !== 'ready') {
        return false;
      }
    }
    return true;
  }

  private buildRunId(nowMs: number): string {
    this.runSequence += 1;
    return `screen-agent-${nowMs}-${this.runSequence}`;
  }

  private logEvent(event: string, details?: Record<string, unknown>): void {
    this.logger({
      scope: 'screen-agent-lifecycle',
      event,
      timestamp: toIso(this.now()),
      runId: this.state.runId,
      phase: this.state.phase,
      startupCount: this.state.startupCount,
      restartCount: this.state.restartCount,
      recheckCount: this.state.recheckCount,
      details,
    });
  }
}
