import { EventEmitter } from 'events';
import type { OpenCodeMessage } from '@accomplish/shared';

export type McpSkillHealthStatus =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'restarting'
  | 'failed'
  | 'stopped';

export type McpHealthTransitionReason =
  | 'tool-activity'
  | 'tool-success'
  | 'tool-error'
  | 'debug-signal'
  | 'restart-scheduled'
  | 'restart-attempt'
  | 'restart-succeeded'
  | 'restart-failed'
  | 'restart-maxed'
  | 'cleanup';

export interface McpSkillHealthState {
  skill: string;
  status: McpSkillHealthStatus;
  lastSeenAt: number | null;
  restartAttempts: number;
  lastRestartAt: number | null;
  nextRestartAt: number | null;
  lastError?: string;
}

export interface McpHealthEvent {
  taskId: string;
  skill: string;
  status: McpSkillHealthStatus;
  previousStatus: McpSkillHealthStatus | null;
  reason: McpHealthTransitionReason;
  timestamp: string;
  lastSeenAt: string | null;
  restartAttempts: number;
  nextRestartDelayMs?: number;
  detail?: string;
  lastError?: string;
}

export interface McpRestartRequest {
  taskId: string;
  skill: string;
  attempt: number;
  reason: string;
}

interface McpSupervisorEvents {
  health: [McpHealthEvent];
}

interface McpSupervisorOptions {
  taskId: string;
  onRestart: (request: McpRestartRequest) => Promise<boolean>;
  onHealthEvent?: (event: McpHealthEvent) => void;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRestartAttempts?: number;
}

const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 5;

const MCP_ERROR_PATTERN =
  /\b(mcp|model context protocol)\b[\s\S]{0,120}\b(error|failed|failure|crash|crashed|disconnect|timed out|timeout|unavailable|closed|broken pipe|enoent|econnreset|terminated)\b/i;
const MCP_OK_PATTERN =
  /\b(mcp|model context protocol)\b[\s\S]{0,120}\b(ready|connected|started|available|healthy)\b/i;

const KNOWN_MCP_SKILLS = [
  'file-permission',
  'screen-capture',
  'live-screen-stream',
  'action-executor',
  'dev-browser',
] as const;

function extractMcpSkillFromToolName(toolName: string): string | null {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('mcp__')) {
    const parts = normalized.split('__');
    if (parts.length >= 3 && parts[1]) {
      return parts[1];
    }
  }

  for (const skill of KNOWN_MCP_SKILLS) {
    if (normalized.includes(skill)) {
      return skill;
    }
  }

  if (normalized.includes('mcp')) {
    return 'mcp';
  }

  return null;
}

function extractMcpSkillFromText(text: string): string | null {
  const normalized = text.toLowerCase();

  const mcpToolMatch = normalized.match(/mcp__([a-z0-9_-]+)__/);
  if (mcpToolMatch?.[1]) {
    return mcpToolMatch[1];
  }

  for (const skill of KNOWN_MCP_SKILLS) {
    if (normalized.includes(skill)) {
      return skill;
    }
  }

  const serverMatch = normalized.match(/\bmcp(?:\s+server)?\s+([a-z0-9_-]+)\b/);
  if (serverMatch?.[1]) {
    return serverMatch[1];
  }

  return normalized.includes('mcp') ? 'mcp' : null;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export class McpSupervisor extends EventEmitter<McpSupervisorEvents> {
  private readonly states = new Map<string, McpSkillHealthState>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private readonly options: Required<
    Pick<McpSupervisorOptions, 'taskId' | 'onRestart' | 'baseBackoffMs' | 'maxBackoffMs' | 'maxRestartAttempts'>
  > &
    Pick<McpSupervisorOptions, 'onHealthEvent'>;
  private disposed = false;

  constructor(options: McpSupervisorOptions) {
    super();
    this.options = {
      taskId: options.taskId,
      onRestart: options.onRestart,
      onHealthEvent: options.onHealthEvent,
      baseBackoffMs: options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      maxRestartAttempts: options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS,
    };
  }

  observeMessage(message: OpenCodeMessage): void {
    if (this.disposed) {
      return;
    }

    if (message.type === 'tool_call') {
      const skill = extractMcpSkillFromToolName(message.part.tool || '');
      if (!skill) {
        return;
      }
      this.markToolActivity(skill, 'Tool call observed');
      return;
    }

    if (message.type === 'tool_use') {
      const skill = extractMcpSkillFromToolName(message.part.tool || '');
      if (!skill) {
        return;
      }

      const toolStatus = message.part.state?.status;
      const output = message.part.state?.output || '';
      if (toolStatus === 'error' || this.looksLikeMcpFailure(output)) {
        this.markFailure(skill, output || 'MCP tool returned error state', 'tool-error');
        return;
      }

      if (toolStatus === 'completed') {
        this.markHealthy(skill, 'Tool completed');
        return;
      }

      this.markToolActivity(skill, `Tool state: ${toolStatus || 'unknown'}`);
      return;
    }

    if (message.type === 'tool_result') {
      const output = message.part.output || '';
      if (!output || !this.looksLikeMcpFailure(output)) {
        return;
      }

      const inferredSkill = extractMcpSkillFromText(output);
      if (!inferredSkill) {
        return;
      }

      this.markFailure(inferredSkill, output, 'tool-error');
    }
  }

  observeDebugLog(log: { type: string; message: string; data?: unknown }): void {
    if (this.disposed) {
      return;
    }

    const text = `${log.message} ${safeStringify(log.data ?? '')}`.trim();
    if (!text) {
      return;
    }

    const skill = extractMcpSkillFromText(text);
    if (!skill) {
      return;
    }

    if (this.looksLikeMcpFailure(text)) {
      this.markFailure(skill, text, 'debug-signal');
      return;
    }

    if (MCP_OK_PATTERN.test(text)) {
      this.markHealthy(skill, 'MCP debug health signal');
    }
  }

  getSkillState(skill: string): McpSkillHealthState | null {
    const state = this.states.get(skill);
    return state ? { ...state } : null;
  }

  getAllSkillStates(): McpSkillHealthState[] {
    return Array.from(this.states.values()).map((state) => ({ ...state }));
  }

  dispose(reason: string = 'Task cleanup'): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const timer of this.restartTimers.values()) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();

    for (const skill of this.states.keys()) {
      this.transition(skill, 'stopped', 'cleanup', reason);
    }

    this.removeAllListeners();
  }

  private markToolActivity(skill: string, detail: string): void {
    const state = this.ensureState(skill);
    state.lastSeenAt = Date.now();
    state.lastError = undefined;
    state.restartAttempts = 0;
    state.nextRestartAt = null;
    this.clearRestartTimer(skill);
    this.transition(skill, 'healthy', 'tool-activity', detail);
  }

  private markHealthy(skill: string, detail: string): void {
    const state = this.ensureState(skill);
    state.lastSeenAt = Date.now();
    state.lastError = undefined;
    state.restartAttempts = 0;
    state.nextRestartAt = null;
    this.clearRestartTimer(skill);
    this.transition(skill, 'healthy', 'tool-success', detail);
  }

  private markFailure(
    skill: string,
    detail: string,
    reason: Extract<McpHealthTransitionReason, 'tool-error' | 'debug-signal'>
  ): void {
    const state = this.ensureState(skill);
    if (state.status === 'failed' || state.status === 'stopped') {
      return;
    }

    state.lastSeenAt = Date.now();
    state.lastError = detail.slice(0, 500);
    this.transition(skill, 'degraded', reason, detail.slice(0, 500));
    this.scheduleRestart(skill, state.lastError);
  }

  private scheduleRestart(skill: string, detail?: string): void {
    const state = this.ensureState(skill);
    if (state.status === 'failed' || state.status === 'stopped') {
      return;
    }

    if (this.restartTimers.has(skill)) {
      return;
    }

    if (state.restartAttempts >= this.options.maxRestartAttempts) {
      this.transition(skill, 'failed', 'restart-maxed', detail);
      return;
    }

    const nextAttempt = state.restartAttempts + 1;
    const delayMs = this.computeBackoffMs(nextAttempt);
    state.nextRestartAt = Date.now() + delayMs;

    this.transition(skill, 'degraded', 'restart-scheduled', detail, delayMs);

    const timer = setTimeout(() => {
      this.restartTimers.delete(skill);
      void this.runRestart(skill, detail);
    }, delayMs);

    this.restartTimers.set(skill, timer);
  }

  private async runRestart(skill: string, detail?: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    const state = this.ensureState(skill);
    if (state.status === 'failed' || state.status === 'stopped') {
      return;
    }

    if (state.restartAttempts >= this.options.maxRestartAttempts) {
      this.transition(skill, 'failed', 'restart-maxed', detail);
      return;
    }

    state.restartAttempts += 1;
    state.lastRestartAt = Date.now();
    state.nextRestartAt = null;

    const attempt = state.restartAttempts;
    this.transition(skill, 'restarting', 'restart-attempt', detail);

    try {
      const restarted = await this.options.onRestart({
        taskId: this.options.taskId,
        skill,
        attempt,
        reason: detail || 'MCP health degraded',
      });

      if (!restarted) {
        throw new Error('Restart callback returned false');
      }

      state.lastSeenAt = Date.now();
      state.lastError = undefined;
      state.restartAttempts = 0;
      state.nextRestartAt = null;
      this.transition(skill, 'healthy', 'restart-succeeded', 'Recovery restart succeeded');
    } catch (error) {
      state.lastError = safeErrorMessage(error).slice(0, 500);
      this.transition(skill, 'degraded', 'restart-failed', state.lastError);
      this.scheduleRestart(skill, state.lastError);
    }
  }

  private transition(
    skill: string,
    status: McpSkillHealthStatus,
    reason: McpHealthTransitionReason,
    detail?: string,
    nextRestartDelayMs?: number
  ): void {
    const existing = this.states.get(skill);
    const state = existing ?? this.ensureState(skill);
    const previousStatus = existing ? existing.status : null;
    state.status = status;

    const event: McpHealthEvent = {
      taskId: this.options.taskId,
      skill,
      status,
      previousStatus,
      reason,
      detail,
      lastError: state.lastError,
      restartAttempts: state.restartAttempts,
      timestamp: new Date().toISOString(),
      lastSeenAt: state.lastSeenAt ? new Date(state.lastSeenAt).toISOString() : null,
      nextRestartDelayMs,
    };

    this.emit('health', event);
    this.options.onHealthEvent?.(event);
  }

  private ensureState(skill: string): McpSkillHealthState {
    const existing = this.states.get(skill);
    if (existing) {
      return existing;
    }

    const created: McpSkillHealthState = {
      skill,
      status: 'unknown',
      lastSeenAt: null,
      restartAttempts: 0,
      lastRestartAt: null,
      nextRestartAt: null,
    };
    this.states.set(skill, created);
    return created;
  }

  private clearRestartTimer(skill: string): void {
    const timer = this.restartTimers.get(skill);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(skill);
    }
  }

  private computeBackoffMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    const raw = this.options.baseBackoffMs * (2 ** exponent);
    return Math.min(this.options.maxBackoffMs, raw);
  }

  private looksLikeMcpFailure(text: string): boolean {
    if (!text) {
      return false;
    }
    return MCP_ERROR_PATTERN.test(text);
  }
}
