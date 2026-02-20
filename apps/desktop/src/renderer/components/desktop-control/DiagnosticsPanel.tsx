'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { cn } from '../../lib/utils';
import type {
  DesktopControlCapability,
  DesktopControlCapabilityStatus,
  DesktopControlStatusPayload,
  DesktopControlStatusSnapshot,
  LegacyDesktopControlStatusSnapshot,
} from '../../lib/accomplish';

interface DiagnosticsPanelProps {
  status?: DesktopControlStatusPayload | null;
  snapshot?: DesktopControlStatusPayload | null;
  readiness?: DesktopControlStatusPayload | null;
  isChecking?: boolean;
  checking?: boolean;
  errorMessage?: string | null;
  onRecheck?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
}

const CAPABILITY_LABELS: Record<DesktopControlCapability, string> = {
  screen_capture: 'Screen capture',
  action_execution: 'Action execution',
  mcp_health: 'Runtime health',
};

interface CapabilityViewModel {
  capability: DesktopControlCapability;
  status: 'ready' | 'blocked' | 'unknown';
  message: string;
  steps: string[];
  remediationTitle?: string;
  systemSettingsPath?: string;
  diagnostics: string[];
}

type DiagnosticsReadinessState = 'ok' | 'degraded' | 'unavailable' | 'unknown';

interface RecheckFeedback {
  kind: 'success' | 'error';
  message: string;
}

const READINESS_UI: Record<
  DiagnosticsReadinessState,
  { label: string; summary: string; cardClass: string; iconClass: string }
> = {
  ok: {
    label: 'OK',
    summary: 'Desktop control dependencies are ready.',
    cardClass: 'border border-success/40 bg-success/5',
    iconClass: 'text-success',
  },
  degraded: {
    label: 'Degraded',
    summary: 'Desktop control is partially ready. Complete the unblock steps below.',
    cardClass: 'border border-warning/40 bg-warning/5',
    iconClass: 'text-warning',
  },
  unavailable: {
    label: 'Unavailable',
    summary: 'Desktop control is unavailable until runtime dependencies are recovered.',
    cardClass: 'border border-destructive/40 bg-destructive/5',
    iconClass: 'text-destructive',
  },
  unknown: {
    label: 'Unknown',
    summary: 'Desktop control readiness could not be determined yet.',
    cardClass: 'border border-border/70 bg-muted/20',
    iconClass: 'text-muted-foreground',
  },
};

function isDetailedSnapshot(
  status: DesktopControlStatusPayload
): status is DesktopControlStatusSnapshot {
  return typeof status === 'object' && status !== null && 'checks' in status;
}

function isLegacySnapshot(
  status: DesktopControlStatusPayload
): status is LegacyDesktopControlStatusSnapshot {
  return typeof status === 'object' && status !== null && 'capabilities' in status;
}

function toCapabilityState(value?: string): 'ready' | 'blocked' | 'unknown' {
  if (!value) return 'unknown';
  if (value === 'ready' || value === 'ok') return 'ready';
  if (!value || value === 'unknown') return 'unknown';
  return 'blocked';
}

function buildLegacyCapabilityMessage(
  capability: DesktopControlCapability,
  rawStatus: string
): string {
  if (rawStatus === 'ready') {
    return `${CAPABILITY_LABELS[capability]} is ready.`;
  }
  if (rawStatus === 'needs_screen_recording_permission') {
    return 'Screen recording permission is required before taking screenshots.';
  }
  if (rawStatus === 'needs_accessibility_permission') {
    return 'Accessibility permission is required before desktop actions can run.';
  }
  if (rawStatus === 'mcp_unhealthy') {
    return 'Desktop control runtime is unhealthy.';
  }
  return `${CAPABILITY_LABELS[capability]} readiness is unknown.`;
}

function getLegacySystemSettingsPath(rawStatus: string): string | undefined {
  if (rawStatus === 'needs_screen_recording_permission') {
    return 'System Settings > Privacy & Security > Screen Recording';
  }
  if (rawStatus === 'needs_accessibility_permission') {
    return 'System Settings > Privacy & Security > Accessibility';
  }
  return undefined;
}

function toObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function summarizeAttempts(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const attempts = value
    .map((attempt) => toObjectRecord(attempt))
    .filter((attempt): attempt is Record<string, unknown> => attempt !== null);

  if (attempts.length === 0) {
    return null;
  }

  const lastAttempt = attempts[attempts.length - 1];
  const lastOutcome = typeof lastAttempt.outcome === 'string' ? lastAttempt.outcome : null;
  const attemptNumber =
    typeof lastAttempt.attempt === 'number' ? Math.floor(lastAttempt.attempt) : attempts.length;

  if (lastOutcome) {
    return `Probe attempts: ${attemptNumber} (last outcome: ${lastOutcome}).`;
  }
  return `Probe attempts: ${attemptNumber}.`;
}

function buildCapabilityDiagnostics(check: DesktopControlCapabilityStatus): string[] {
  const diagnostics: string[] = [];
  const details = toObjectRecord(check.details);

  if (check.errorCode) {
    diagnostics.push(`Error code: ${check.errorCode}.`);
  }

  const readinessReasonCode =
    details && typeof details.readinessReasonCode === 'string' ? details.readinessReasonCode : null;
  if (readinessReasonCode) {
    diagnostics.push(`Reason code: ${readinessReasonCode}.`);
  }

  const attemptsSummary = summarizeAttempts(details?.attempts);
  if (attemptsSummary) {
    diagnostics.push(attemptsSummary);
  }

  const cause = details && typeof details.cause === 'string' ? details.cause : null;
  if (cause) {
    diagnostics.push(`Cause: ${cause}.`);
  }

  const issues = toStringArray(details?.issues);
  if (issues.length > 0) {
    diagnostics.push(`Issue: ${issues[0]}.`);
  }

  return diagnostics;
}

function getCapabilityViews(status: DesktopControlStatusPayload | null): CapabilityViewModel[] {
  if (!status) return [];

  if (isDetailedSnapshot(status)) {
    const checks: DesktopControlCapabilityStatus[] = [
      status.checks?.screen_capture,
      status.checks?.action_execution,
      status.checks?.mcp_health,
    ].filter(Boolean) as DesktopControlCapabilityStatus[];

    return checks.map((check) => ({
      capability: check.capability,
      status: check.status === 'ready' ? 'ready' : check.status === 'blocked' ? 'blocked' : 'unknown',
      message: check.message,
      steps: check.remediation?.steps ?? [],
      remediationTitle: check.remediation?.title,
      systemSettingsPath: check.remediation?.systemSettingsPath,
      diagnostics: check.status === 'ready' ? [] : buildCapabilityDiagnostics(check),
    }));
  }

  if (!isLegacySnapshot(status)) return [];

  const screenStatus = status.capabilities?.screen_capture ?? 'unknown';
  const actionStatus = status.capabilities?.action_execution ?? 'unknown';
  const mcpStatus = status.capabilities?.mcp_health ?? 'unknown';

  const baseStep = status.remediation ? [status.remediation] : [];

  return [
    {
      capability: 'screen_capture',
      status: toCapabilityState(screenStatus),
      message: buildLegacyCapabilityMessage('screen_capture', screenStatus),
      steps: baseStep,
      diagnostics: [],
      systemSettingsPath: getLegacySystemSettingsPath(screenStatus),
    },
    {
      capability: 'action_execution',
      status: toCapabilityState(actionStatus),
      message: buildLegacyCapabilityMessage('action_execution', actionStatus),
      steps: baseStep,
      diagnostics: [],
      systemSettingsPath: getLegacySystemSettingsPath(actionStatus),
    },
    {
      capability: 'mcp_health',
      status: toCapabilityState(mcpStatus),
      message: buildLegacyCapabilityMessage('mcp_health', mcpStatus),
      steps: baseStep,
      diagnostics: [],
      systemSettingsPath: getLegacySystemSettingsPath(mcpStatus),
    },
  ];
}

function normalizeOverallStatus(rawStatus?: string | null): DiagnosticsReadinessState | null {
  if (!rawStatus) return null;

  if (rawStatus === 'ready' || rawStatus === 'ok') return 'ok';
  if (
    rawStatus === 'needs_screen_recording_permission' ||
    rawStatus === 'needs_accessibility_permission' ||
    rawStatus === 'degraded'
  ) {
    return 'degraded';
  }
  if (rawStatus === 'mcp_unhealthy' || rawStatus === 'unavailable') return 'unavailable';
  if (rawStatus === 'unknown') return 'unknown';

  return null;
}

function getErrorCode(status: DesktopControlStatusPayload | null): string | null {
  if (!status || typeof status !== 'object' || !('errorCode' in status)) return null;
  const code = (status as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' ? code : null;
}

function isUnavailableSignal(
  status: DesktopControlStatusPayload | null,
  capabilityViews: CapabilityViewModel[],
  errorMessage?: string | null
): boolean {
  const errorCode = getErrorCode(status);
  if (errorCode?.toLowerCase().includes('unavailable')) return true;
  if (errorMessage?.toLowerCase().includes('unavailable')) return true;
  if (capabilityViews.some((view) => view.capability === 'mcp_health' && view.status === 'blocked')) {
    return true;
  }
  return false;
}

function getReadinessState(
  status: DesktopControlStatusPayload | null,
  capabilityViews: CapabilityViewModel[],
  errorMessage?: string | null
): DiagnosticsReadinessState {
  const normalizedStatus = normalizeOverallStatus(status?.status ? String(status.status) : undefined);
  if (normalizedStatus && normalizedStatus !== 'unknown') return normalizedStatus;

  if (isUnavailableSignal(status, capabilityViews, errorMessage)) return 'unavailable';
  if (normalizedStatus === 'unknown') return 'unknown';

  const hasBlockedMcp = capabilityViews.some(
    (view) => view.capability === 'mcp_health' && view.status === 'blocked'
  );
  if (hasBlockedMcp) return 'unavailable';

  const hasBlockedCapability = capabilityViews.some(
    (view) => view.capability !== 'mcp_health' && view.status === 'blocked'
  );
  if (hasBlockedCapability) return 'degraded';

  if (capabilityViews.length > 0 && capabilityViews.every((view) => view.status === 'ready')) {
    return 'ok';
  }
  if (capabilityViews.some((view) => view.status === 'unknown')) return 'unknown';
  if (errorMessage) return 'unknown';

  return 'unknown';
}

function getStepList(
  status: DesktopControlStatusPayload | null,
  capabilityViews: CapabilityViewModel[],
  readinessState: DiagnosticsReadinessState,
  errorMessage?: string | null
): string[] {
  if (!status) {
    if (errorMessage) {
      return [
        'Press Recheck to retry desktop-control readiness.',
        'If this keeps failing, restart Screen Agent and recheck again.',
      ];
    }
    return ['Running desktop-control readiness check.'];
  }

  const blockedSteps = capabilityViews
    .filter((view) => view.status !== 'ready')
    .flatMap((view) => view.steps);

  const baseSteps = isDetailedSnapshot(status)
    ? status.remediation?.steps ?? []
    : status.remediation
      ? [status.remediation]
      : [];

  const steps = [...baseSteps, ...blockedSteps];

  const unique = Array.from(new Set(steps));
  if (unique.length > 0) return unique;

  if (readinessState === 'ok') {
    return ['Desktop control dependencies are ready.'];
  }
  if (readinessState === 'degraded') {
    return ['Resolve blocked capabilities above, then press Recheck.'];
  }
  if (readinessState === 'unavailable') {
    return [
      'Restart Screen Agent, verify runtime dependencies, then press Recheck.',
      'If unavailable persists, reinstall or re-sync the app resources.',
    ];
  }
  return ['Press Recheck to rerun desktop-control readiness checks.'];
}

function renderCapability(view: CapabilityViewModel) {
  const isReady = view.status === 'ready';
  const isUnknown = view.status === 'unknown';

  return (
    <div key={view.capability} className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">
          {CAPABILITY_LABELS[view.capability]}
        </span>
        <span
          className={cn(
            'text-xs font-medium',
            isReady ? 'text-success' : isUnknown ? 'text-muted-foreground' : 'text-destructive'
          )}
        >
          {isUnknown ? 'Unknown' : isReady ? 'Ready' : 'Blocked'}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{view.message}</p>
      {view.remediationTitle && !isReady && (
        <p className="mt-1 text-xs font-medium text-foreground">{view.remediationTitle}</p>
      )}
      {view.systemSettingsPath && !isReady && (
        <p className="mt-1 text-xs text-muted-foreground">
          Open: {view.systemSettingsPath}
        </p>
      )}
      {!isReady && view.diagnostics.length > 0 && (
        <ul
          className="mt-1 space-y-1"
          data-testid={`desktop-control-capability-diagnostics-${view.capability}`}
        >
          {view.diagnostics.map((diagnostic, index) => (
            <li key={`${view.capability}-diagnostic-${index}`} className="text-xs text-muted-foreground">
              {diagnostic}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DiagnosticsPanel({
  status,
  snapshot,
  readiness,
  isChecking,
  checking,
  errorMessage,
  onRecheck,
  onRefresh,
  onRetry,
}: DiagnosticsPanelProps) {
  const resolvedStatus = status ?? snapshot ?? readiness ?? null;
  const resolvedIsChecking = isChecking ?? checking ?? false;
  const hasExternalCheckingSignal = typeof isChecking === 'boolean' || typeof checking === 'boolean';
  const handleRecheck = onRecheck ?? onRefresh ?? onRetry ?? (() => {});

  const [localRecheckPending, setLocalRecheckPending] = useState(false);
  const [awaitingExternalCompletion, setAwaitingExternalCompletion] = useState(false);
  const [sawExternalChecking, setSawExternalChecking] = useState(false);
  const [recheckFeedback, setRecheckFeedback] = useState<RecheckFeedback | null>(null);

  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestErrorRef = useRef<string | null | undefined>(errorMessage);

  const clearFallbackTimer = () => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  };

  useEffect(() => {
    latestErrorRef.current = errorMessage;
  }, [errorMessage]);

  useEffect(() => {
    return () => {
      clearFallbackTimer();
    };
  }, []);

  useEffect(() => {
    if (!awaitingExternalCompletion) return;
    if (resolvedIsChecking) {
      setSawExternalChecking(true);
      clearFallbackTimer();
      return;
    }
    if (!sawExternalChecking) return;

    setAwaitingExternalCompletion(false);
    setSawExternalChecking(false);
    setRecheckFeedback(
      latestErrorRef.current
        ? { kind: 'error', message: latestErrorRef.current }
        : { kind: 'success', message: 'Recheck completed.' }
    );
  }, [awaitingExternalCompletion, resolvedIsChecking, sawExternalChecking]);

  useEffect(() => {
    if (recheckFeedback?.kind !== 'success') return;
    const timer = setTimeout(() => {
      setRecheckFeedback(null);
    }, 2500);
    return () => {
      clearTimeout(timer);
    };
  }, [recheckFeedback]);

  const runRecheck = async () => {
    const currentlyPending = resolvedIsChecking || localRecheckPending || awaitingExternalCompletion;
    if (currentlyPending) return;

    setRecheckFeedback(null);

    if (hasExternalCheckingSignal) {
      setAwaitingExternalCompletion(true);
      setSawExternalChecking(false);
      clearFallbackTimer();
      fallbackTimerRef.current = setTimeout(() => {
        setAwaitingExternalCompletion((active) => {
          if (!active) return active;
          setRecheckFeedback(
            latestErrorRef.current
              ? { kind: 'error', message: latestErrorRef.current }
              : { kind: 'success', message: 'Recheck completed.' }
          );
          return false;
        });
        setSawExternalChecking(false);
      }, 350);
    } else {
      setLocalRecheckPending(true);
    }

    try {
      await Promise.resolve(handleRecheck());
      if (!hasExternalCheckingSignal) {
        setRecheckFeedback({ kind: 'success', message: 'Recheck completed.' });
      }
    } catch (error) {
      clearFallbackTimer();
      setAwaitingExternalCompletion(false);
      setSawExternalChecking(false);
      setRecheckFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Recheck failed. Please try again.',
      });
    } finally {
      if (!hasExternalCheckingSignal) {
        setLocalRecheckPending(false);
      }
    }
  };

  const effectiveErrorMessage =
    recheckFeedback?.kind === 'error' ? recheckFeedback.message : errorMessage;
  const capabilityViews = getCapabilityViews(resolvedStatus);
  const readinessState = getReadinessState(resolvedStatus, capabilityViews, effectiveErrorMessage);
  const readinessUi = READINESS_UI[readinessState];
  const isRecheckPending = resolvedIsChecking || localRecheckPending || awaitingExternalCompletion;
  const hasBlockingState = readinessState !== 'ok';
  const stepList = getStepList(
    resolvedStatus,
    capabilityViews,
    readinessState,
    effectiveErrorMessage
  );
  const recheckButtonLabel = isRecheckPending
    ? 'Rechecking...'
    : recheckFeedback?.kind === 'success'
      ? 'Checked'
      : 'Recheck';

  if (readinessState === 'ok' && !effectiveErrorMessage && !isRecheckPending && !recheckFeedback) {
    return null;
  }

  return (
    <Card
      className={cn('p-3', readinessUi.cardClass)}
      data-testid="desktop-control-diagnostics-panel"
      role="alert"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {hasBlockingState ? (
            <AlertTriangle className={cn('mt-0.5 h-4 w-4', readinessUi.iconClass)} />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
          )}
          <div>
            <h3 className="text-sm font-semibold text-foreground">Desktop Control Diagnostics</h3>
            <p className="text-xs text-muted-foreground">
              {readinessUi.label}
              {resolvedStatus?.checkedAt
                ? ` • Checked ${new Date(resolvedStatus.checkedAt).toLocaleTimeString()}`
                : ''}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{readinessUi.summary}</p>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            void runRecheck();
          }}
          disabled={isRecheckPending}
          data-testid="desktop-control-recheck-button"
        >
          {isRecheckPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : recheckFeedback?.kind === 'success' ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {recheckButtonLabel}
        </Button>
      </div>

      <div className="mt-3 space-y-2">
        {effectiveErrorMessage && (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="desktop-control-recheck-error"
          >
            {effectiveErrorMessage}
          </p>
        )}

        {recheckFeedback?.kind === 'success' && (
          <p
            className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success"
            data-testid="desktop-control-recheck-success"
          >
            {recheckFeedback.message}
          </p>
        )}

        {resolvedStatus?.message && (
          <p className="text-xs text-foreground">{resolvedStatus.message}</p>
        )}

        <div className="space-y-2">
          {capabilityViews.length > 0 && (
            <>
              {capabilityViews.map((view) => renderCapability(view))}
            </>
          )}
        </div>

        <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
          <p className="text-xs font-medium text-foreground">Unblock steps</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            {stepList.map((step, index) => (
              <li key={`${index}-${step}`} className="text-xs text-muted-foreground">
                {step}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Card>
  );
}

export default DiagnosticsPanel;
