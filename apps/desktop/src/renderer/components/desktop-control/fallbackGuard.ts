import type {
  DesktopControlCapability,
  DesktopControlStatusPayload,
  DesktopControlStatusSnapshot,
} from '../../lib/accomplish';

export interface DesktopControlRequirement {
  blockedAction: string;
  capabilities: DesktopControlCapability[];
}

const CAPABILITY_LABELS: Record<DesktopControlCapability, string> = {
  screen_capture: 'screen capture',
  action_execution: 'action execution',
  mcp_health: 'runtime health',
};

function isDetailedDesktopControlStatus(
  status: DesktopControlStatusPayload
): status is DesktopControlStatusSnapshot {
  return typeof status === 'object' && status !== null && 'checks' in status;
}

function toLegacyCheckStatus(value: string | undefined): 'ready' | 'blocked' | 'unknown' {
  if (!value || value === 'unknown') return 'unknown';
  if (value === 'ready' || value === 'ok') return 'ready';
  return 'blocked';
}

function getCapabilityCheckStatus(
  status: DesktopControlStatusPayload,
  capability: DesktopControlCapability
): 'ready' | 'blocked' | 'unknown' {
  if (isDetailedDesktopControlStatus(status)) {
    return status.checks?.[capability]?.status ?? 'unknown';
  }

  const legacyStatus = status.capabilities?.[capability];
  return toLegacyCheckStatus(typeof legacyStatus === 'string' ? legacyStatus : undefined);
}

function getOverallErrorCode(status: DesktopControlStatusPayload): string | null {
  if (typeof status !== 'object' || status === null || !('errorCode' in status)) {
    return null;
  }

  const code = (status as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' ? code : null;
}

function getCapabilityErrorCode(
  status: DesktopControlStatusPayload,
  capability: DesktopControlCapability
): string | null {
  if (!isDetailedDesktopControlStatus(status)) {
    return null;
  }

  const code = status.checks?.[capability]?.errorCode;
  return typeof code === 'string' ? code : null;
}

function findSystemSettingsPath(
  status: DesktopControlStatusPayload,
  blockedCapabilities: DesktopControlCapability[]
): string | null {
  if (!isDetailedDesktopControlStatus(status)) {
    return null;
  }

  for (const capability of blockedCapabilities) {
    const path = status.checks?.[capability]?.remediation?.systemSettingsPath;
    if (typeof path === 'string' && path.length > 0) {
      return path;
    }
  }

  return null;
}

function formatCapabilityList(capabilities: DesktopControlCapability[]): string {
  const labels = capabilities.map((capability) => CAPABILITY_LABELS[capability] ?? capability);
  if (labels.length === 0) return 'desktop control dependencies';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

export function getDesktopControlBlockedCapabilities(
  status: DesktopControlStatusPayload,
  requirement: DesktopControlRequirement
): DesktopControlCapability[] {
  return requirement.capabilities.filter(
    (capability) => getCapabilityCheckStatus(status, capability) !== 'ready'
  );
}

export function createDesktopControlBlockerKey(
  status: DesktopControlStatusPayload,
  requirement: DesktopControlRequirement
): string {
  const blockedCapabilities = getDesktopControlBlockedCapabilities(status, requirement).sort();
  const overallStatus = typeof status.status === 'string' ? status.status : 'unknown';
  const overallErrorCode = getOverallErrorCode(status) ?? 'none';
  const blockedKey = blockedCapabilities
    .map(
      (capability) =>
        `${capability}:${getCapabilityCheckStatus(status, capability)}:${
          getCapabilityErrorCode(status, capability) ?? 'none'
        }`
    )
    .join('|');

  return [
    requirement.blockedAction,
    overallStatus,
    overallErrorCode,
    blockedKey || 'no-blocked-capabilities',
  ].join('|');
}

export function buildDesktopControlBlockedMessage(
  status: DesktopControlStatusPayload,
  requirement: DesktopControlRequirement
): string {
  const blockedCapabilities = getDesktopControlBlockedCapabilities(status, requirement);
  if (blockedCapabilities.length === 0) {
    return `Desktop control is ready for ${requirement.blockedAction}.`;
  }

  const capabilityList = formatCapabilityList(blockedCapabilities);
  const blockerVerb = blockedCapabilities.length === 1 ? 'is' : 'are';
  const blockerCode =
    blockedCapabilities
      .map((capability) => getCapabilityErrorCode(status, capability))
      .find((code): code is string => Boolean(code)) ?? null;
  const codeSuffix = blockerCode ? ` (${blockerCode})` : '';
  const settingsPath = findSystemSettingsPath(status, blockedCapabilities);
  const remediation = settingsPath
    ? `Open ${settingsPath}, press Recheck, then tell me to continue.`
    : 'Follow the Diagnostics unblock steps, press Recheck, then tell me to continue.';

  return `I cannot run ${requirement.blockedAction} yet because ${capabilityList} ${blockerVerb} blocked${codeSuffix}. ${remediation}`;
}

export function shouldEmitDesktopControlFallback(
  previousBlockerKey: string | null,
  nextBlockerKey: string
): boolean {
  return previousBlockerKey !== nextBlockerKey;
}
