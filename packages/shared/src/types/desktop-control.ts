/**
 * Shared desktop-control contracts for readiness, tool failures, and MCP health.
 */

export type DesktopControlCapability = 'screen_capture' | 'action_execution' | 'mcp_health';

export type DesktopControlStatus =
  | 'ready'
  | 'needs_screen_recording_permission'
  | 'needs_accessibility_permission'
  | 'mcp_unhealthy'
  | 'unknown';

export type ScreenCaptureReadinessStatus =
  | 'ready'
  | 'needs_screen_recording_permission'
  | 'mcp_unhealthy'
  | 'unknown';

export type ActionExecutionReadinessStatus =
  | 'ready'
  | 'needs_accessibility_permission'
  | 'mcp_unhealthy'
  | 'unknown';

export type McpHealthReadinessStatus = 'ready' | 'degraded' | 'mcp_unhealthy' | 'unknown';

export interface DesktopControlCapabilityStatuses {
  screen_capture: ScreenCaptureReadinessStatus;
  action_execution: ActionExecutionReadinessStatus;
  mcp_health: McpHealthReadinessStatus;
}

export interface DesktopControlReadinessSnapshot {
  status: DesktopControlStatus;
  capabilities: DesktopControlCapabilityStatuses;
  checkedAt: number;
  message?: string;
  remediation?: string;
}

export type ToolErrorCode =
  | 'ERR_PERMISSION_DENIED'
  | 'ERR_TIMEOUT'
  | 'ERR_UNAVAILABLE_BINARY'
  | 'ERR_VALIDATION_ERROR'
  | 'ERR_UNKNOWN';

export interface ToolFailure {
  code: ToolErrorCode;
  message: string;
  capability?: DesktopControlCapability;
  retryable?: boolean;
}

export type McpSkillState = 'healthy' | 'degraded' | 'unhealthy' | 'starting' | 'stopped' | 'unknown';

export interface McpSkillHealth {
  state: McpSkillState;
  lastSeenAt?: number;
  lastRestartAt?: number;
  updatedAt: number;
  restartAttempts: number;
  error?: ToolFailure;
}

export interface ToolHealthSnapshot {
  checkedAt: number;
  overallState: McpHealthReadinessStatus;
  skills: Record<string, McpSkillHealth>;
}
