#!/usr/bin/env node
/**
 * Live Screen Stream MCP Server
 *
 * Provides sampled live-view sessions that capture screenshots at a fixed rate.
 * Sessions default to 1 FPS and expire deterministically after at most 30 seconds.
 */

import { exec } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

const execAsync = promisify(exec);

const DEFAULT_SAMPLE_FPS = 1;
const DEFAULT_SESSION_LIFETIME_SECONDS = 30;
const MAX_SESSION_LIFETIME_SECONDS = 30;
const TEMP_DIR = path.join(os.tmpdir(), 'live-screen-stream-captures');
const SCREENCAPTURE_BIN = existsSync('/usr/sbin/screencapture')
  ? '/usr/sbin/screencapture'
  : 'screencapture';

if (!existsSync(TEMP_DIR)) {
  mkdirSync(TEMP_DIR, { recursive: true });
}

type ToolErrorCode = 'INVALID_SESSION' | 'EXPIRED_SESSION' | 'CAPTURE_FAILURE';

interface LiveFrame {
  data: string;
  mimeType: 'image/png';
  capturedAt: number;
  sequence: number;
}

interface LiveSession {
  id: string;
  createdAt: number;
  expiresAt: number;
  sampleFps: number;
  sampleIntervalMs: number;
  includeCursor: boolean;
  activeWindowOnly: boolean;
  timer: NodeJS.Timeout | null;
  latestFrame: LiveFrame | null;
  lastCaptureAttemptAt: number;
  lastCaptureError: string | null;
  captureInProgress: boolean;
}

interface StartLiveViewArgs {
  sample_fps?: number;
  duration_seconds?: number;
  include_cursor?: boolean;
  active_window_only?: boolean;
}

interface SessionArgs {
  session_id?: string;
}

const activeSessions = new Map<string, LiveSession>();
const expiredSessions = new Map<string, number>();

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function errorResult(code: ToolErrorCode, message: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: { code, message } }),
      },
    ],
  };
}

function cleanupExpiredSessions(now = Date.now()): void {
  for (const [sessionId, session] of activeSessions.entries()) {
    if (now >= session.expiresAt) {
      expireSession(sessionId, now);
    }
  }
}

function destroyActiveSession(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }

  activeSessions.delete(sessionId);
}

function expireSession(sessionId: string, expiredAt: number): void {
  if (!activeSessions.has(sessionId)) {
    return;
  }

  destroyActiveSession(sessionId);
  expiredSessions.set(sessionId, expiredAt);
}

function resolveSession(sessionId: string): { session: LiveSession | null; error: CallToolResult | null } {
  cleanupExpiredSessions();

  const session = activeSessions.get(sessionId);
  if (session) {
    return { session, error: null };
  }

  if (expiredSessions.has(sessionId)) {
    return {
      session: null,
      error: errorResult('EXPIRED_SESSION', `Live view session expired: ${sessionId}`),
    };
  }

  return {
    session: null,
    error: errorResult('INVALID_SESSION', `Unknown live view session: ${sessionId}`),
  };
}

async function captureScreen(options: { includeCursor: boolean; activeWindowOnly: boolean }): Promise<string> {
  const timestamp = Date.now();
  const filePath = path.join(TEMP_DIR, `live_frame_${timestamp}_${randomUUID()}.png`);

  let cmd = `${SCREENCAPTURE_BIN} -x`;

  if (options.includeCursor) {
    cmd += ' -C';
  }

  if (options.activeWindowOnly) {
    try {
      const { stdout } = await execAsync(`
        osascript -e 'tell application "System Events"
          tell (first application process whose frontmost is true)
            tell (first window)
              return {position, size}
            end tell
          end tell
        end tell'
      `);

      const boundsMatch = stdout.match(/(\d+),\s*(\d+).*?(\d+),\s*(\d+)/);
      if (boundsMatch) {
        const [, x, y, width, height] = boundsMatch;
        cmd += ` -R${x},${y},${width},${height}`;
      }
    } catch (error) {
      console.error('Could not resolve active window bounds, falling back to full screen capture:', error);
    }
  }

  cmd += ` "${filePath}"`;

  try {
    await execAsync(cmd);
    const imageBuffer = await fs.readFile(filePath);
    return imageBuffer.toString('base64');
  } finally {
    await fs.unlink(filePath).catch(() => undefined);
  }
}

async function captureSessionFrame(session: LiveSession): Promise<void> {
  if (!activeSessions.has(session.id) || session.captureInProgress) {
    return;
  }

  const now = Date.now();
  if (now >= session.expiresAt) {
    expireSession(session.id, now);
    return;
  }

  session.captureInProgress = true;
  session.lastCaptureAttemptAt = now;

  try {
    const frameData = await captureScreen({
      includeCursor: session.includeCursor,
      activeWindowOnly: session.activeWindowOnly,
    });

    if (!activeSessions.has(session.id)) {
      return;
    }

    const capturedAt = Date.now();
    if (capturedAt >= session.expiresAt) {
      expireSession(session.id, capturedAt);
      return;
    }

    const nextSequence = (session.latestFrame?.sequence ?? 0) + 1;
    session.latestFrame = {
      data: frameData,
      mimeType: 'image/png',
      capturedAt,
      sequence: nextSequence,
    };
    session.lastCaptureError = null;
  } catch (error) {
    if (activeSessions.has(session.id)) {
      session.lastCaptureError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    session.captureInProgress = false;
  }
}

function parseStartArgs(rawArgs: unknown): {
  sampleFps: number;
  durationSeconds: number;
  includeCursor: boolean;
  activeWindowOnly: boolean;
} {
  const args = asObject(rawArgs) as StartLiveViewArgs;

  const sampleFpsInput = args.sample_fps;
  const sampleFps =
    typeof sampleFpsInput === 'number' && Number.isFinite(sampleFpsInput) && sampleFpsInput > 0
      ? sampleFpsInput
      : DEFAULT_SAMPLE_FPS;

  const durationInput = args.duration_seconds;
  const durationSeconds = Math.max(
    1,
    Math.min(
      MAX_SESSION_LIFETIME_SECONDS,
      typeof durationInput === 'number' && Number.isFinite(durationInput)
        ? Math.floor(durationInput)
        : DEFAULT_SESSION_LIFETIME_SECONDS
    )
  );

  const includeCursor = typeof args.include_cursor === 'boolean' ? args.include_cursor : true;
  const activeWindowOnly = typeof args.active_window_only === 'boolean' ? args.active_window_only : false;

  return { sampleFps, durationSeconds, includeCursor, activeWindowOnly };
}

function parseSessionId(rawArgs: unknown): string | null {
  const args = asObject(rawArgs) as SessionArgs;
  return typeof args.session_id === 'string' && args.session_id.trim().length > 0
    ? args.session_id.trim()
    : null;
}

async function handleStartLiveView(rawArgs: unknown): Promise<CallToolResult> {
  cleanupExpiredSessions();

  const { sampleFps, durationSeconds, includeCursor, activeWindowOnly } = parseStartArgs(rawArgs);
  const sampleIntervalMs = Math.max(100, Math.round(1000 / sampleFps));
  const createdAt = Date.now();
  const expiresAt = createdAt + durationSeconds * 1000;

  const session: LiveSession = {
    id: randomUUID(),
    createdAt,
    expiresAt,
    sampleFps,
    sampleIntervalMs,
    includeCursor,
    activeWindowOnly,
    timer: null,
    latestFrame: null,
    lastCaptureAttemptAt: 0,
    lastCaptureError: null,
    captureInProgress: false,
  };

  activeSessions.set(session.id, session);

  await captureSessionFrame(session);
  if (!session.latestFrame) {
    const message = session.lastCaptureError ?? 'Unable to capture initial frame';
    destroyActiveSession(session.id);
    return errorResult('CAPTURE_FAILURE', `Failed to start live view: ${message}`);
  }

  session.timer = setInterval(() => {
    const current = activeSessions.get(session.id);
    if (!current) {
      return;
    }

    const now = Date.now();
    if (now >= current.expiresAt) {
      expireSession(current.id, now);
      return;
    }

    void captureSessionFrame(current);
  }, sampleIntervalMs);
  session.timer.unref?.();

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          session_id: session.id,
          sample_fps: session.sampleFps,
          sample_interval_ms: session.sampleIntervalMs,
          started_at: toIso(session.createdAt),
          expires_at: toIso(session.expiresAt),
          expires_in_seconds: durationSeconds,
          max_lifetime_seconds: MAX_SESSION_LIFETIME_SECONDS,
          initial_frame_sequence: session.latestFrame.sequence,
          initial_frame_captured_at: toIso(session.latestFrame.capturedAt),
        }),
      },
    ],
  };
}

async function handleGetLiveFrame(rawArgs: unknown): Promise<CallToolResult> {
  const sessionId = parseSessionId(rawArgs);
  if (!sessionId) {
    return errorResult('INVALID_SESSION', 'session_id is required');
  }

  const { session, error } = resolveSession(sessionId);
  if (error || !session) {
    return error ?? errorResult('INVALID_SESSION', `Unknown live view session: ${sessionId}`);
  }

  const now = Date.now();
  if (now >= session.expiresAt) {
    expireSession(session.id, now);
    return errorResult('EXPIRED_SESSION', `Live view session expired: ${sessionId}`);
  }

  const latestFrame = session.latestFrame;
  if (
    session.lastCaptureError &&
    (!latestFrame || session.lastCaptureAttemptAt > latestFrame.capturedAt)
  ) {
    return errorResult('CAPTURE_FAILURE', `Failed to capture frame: ${session.lastCaptureError}`);
  }

  if (!latestFrame) {
    return errorResult('CAPTURE_FAILURE', `No frame available for live view session: ${sessionId}`);
  }

  return {
    content: [
      {
        type: 'image',
        data: latestFrame.data,
        mimeType: latestFrame.mimeType,
      },
      {
        type: 'text',
        text: JSON.stringify({
          session_id: session.id,
          frame_sequence: latestFrame.sequence,
          captured_at: toIso(latestFrame.capturedAt),
          stale_ms: Math.max(0, now - latestFrame.capturedAt),
          expires_at: toIso(session.expiresAt),
          sample_fps: session.sampleFps,
        }),
      },
    ],
  };
}

function handleStopLiveView(rawArgs: unknown): CallToolResult {
  const sessionId = parseSessionId(rawArgs);
  if (!sessionId) {
    return errorResult('INVALID_SESSION', 'session_id is required');
  }

  cleanupExpiredSessions();

  const session = activeSessions.get(sessionId);
  if (session) {
    destroyActiveSession(sessionId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            session_id: sessionId,
            status: 'stopped',
            stopped_at: toIso(Date.now()),
          }),
        },
      ],
    };
  }

  if (expiredSessions.has(sessionId)) {
    return errorResult('EXPIRED_SESSION', `Live view session expired: ${sessionId}`);
  }

  return errorResult('INVALID_SESSION', `Unknown live view session: ${sessionId}`);
}

function cleanupAllSessions(): void {
  for (const sessionId of activeSessions.keys()) {
    destroyActiveSession(sessionId);
  }
  expiredSessions.clear();
}

const expirySweepTimer = setInterval(() => cleanupExpiredSessions(), 1000);
expirySweepTimer.unref?.();

process.on('exit', () => {
  clearInterval(expirySweepTimer);
  cleanupAllSessions();
});

const server = new Server(
  { name: 'live-screen-stream', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'start_live_view',
      description:
        'Start a sampled live-view screen session. Captures frames continuously (default 1 FPS) and returns a session_id for polling.',
      inputSchema: {
        type: 'object',
        properties: {
          sample_fps: {
            type: 'number',
            description: `Frame sampling rate in FPS (default: ${DEFAULT_SAMPLE_FPS})`,
            default: DEFAULT_SAMPLE_FPS,
          },
          duration_seconds: {
            type: 'number',
            description: `Session lifetime in seconds (max: ${MAX_SESSION_LIFETIME_SECONDS}, default: ${DEFAULT_SESSION_LIFETIME_SECONDS})`,
            default: DEFAULT_SESSION_LIFETIME_SECONDS,
          },
          include_cursor: {
            type: 'boolean',
            description: 'Whether to include the mouse cursor in captured frames',
            default: true,
          },
          active_window_only: {
            type: 'boolean',
            description: 'If true, capture only the current active window region',
            default: false,
          },
        },
        required: [],
      },
    },
    {
      name: 'get_live_frame',
      description: 'Retrieve the latest sampled frame for an active live-view session.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Session identifier returned from start_live_view',
          },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'stop_live_view',
      description: 'Stop an active live-view session and clean up all resources for that session.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Session identifier returned from start_live_view',
          },
        },
        required: ['session_id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'start_live_view':
        return await handleStartLiveView(args);
      case 'get_live_frame':
        return await handleGetLiveFrame(args);
      case 'stop_live_view':
        return handleStopLiveView(args);
      default:
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }],
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult('CAPTURE_FAILURE', message);
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Live Screen Stream MCP Server started');
}

main().catch((error) => {
  clearInterval(expirySweepTimer);
  cleanupAllSessions();
  console.error('Failed to start server:', error);
  process.exit(1);
});
