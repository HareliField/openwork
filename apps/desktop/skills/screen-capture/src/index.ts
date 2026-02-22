#!/usr/bin/env node
/**
 * Screen Capture MCP Server
 *
 * Provides tools for capturing screenshots and background window context on macOS.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn, exec, execFile, type ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const CAPTURE_MAX_RETRIES = 3;
const CAPTURE_RETRY_DELAY_MS = 250;
const HELPER_REQUEST_TIMEOUT_MS = 12000;
const BACKGROUND_SAMPLE_INTERVAL_MS = 5000;
const BACKGROUND_CACHE_TTL_MS = 7000;
const BACKGROUND_MAX_WINDOW_IMAGE_BYTES = 512 * 1024;
const BACKGROUND_MAX_IMAGE_DIMENSION = 1000;
const TARGET_WINDOW_IMAGE_BYTES = 2 * 1024 * 1024;
const TARGET_IMAGE_DIMENSION = 1800;
const TINY_IMAGE_BYTES = 1024;
const MAX_CAPTURED_WINDOWS_PER_REFRESH = 3;
const MIN_BACKGROUND_WINDOWS_PER_REFRESH = 2;
const MIN_FOREGROUND_WINDOWS_PER_REFRESH = 1;

const SCREENCAPTURE_BIN = fs.existsSync('/usr/sbin/screencapture')
  ? '/usr/sbin/screencapture'
  : 'screencapture';

const SIPS_BIN = fs.existsSync('/usr/bin/sips') ? '/usr/bin/sips' : null;

type CaptureMode = 'active-window' | 'full-screen';
type WindowCaptureState =
  | 'capturable'
  | 'minimized'
  | 'offscreen'
  | 'permission_denied'
  | 'protected_or_blank'
  | 'not_found'
  | 'unknown';

type ErrorCode =
  | 'ERR_UNKNOWN_TOOL'
  | 'ERR_INVALID_INPUT'
  | 'ERR_CAPTURE_PERMISSION_DENIED'
  | 'ERR_CAPTURE_COMMAND_FAILED'
  | 'ERR_CAPTURE_OUTPUT_MISSING'
  | 'ERR_CAPTURE_RETRY_EXHAUSTED'
  | 'ERR_SCREEN_INFO_FAILED'
  | 'ERR_DESKTOP_CONTEXT_UNAVAILABLE'
  | 'ERR_DESKTOP_CONTEXT_PROTOCOL'
  | 'ERR_DESKTOP_CONTEXT_TIMEOUT'
  | 'ERR_DESKTOP_CONTEXT_HELPER_EXITED'
  | 'ERR_DESKTOP_CONTEXT_PERMISSION_DENIED'
  | 'ERR_DESKTOP_CONTEXT_ACCESSIBILITY_DENIED'
  | 'ERR_DESKTOP_CONTEXT_WINDOW_NOT_FOUND'
  | 'ERR_IMAGE_TOO_LARGE'
  | 'ERR_INTERNAL';

class ToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly recoverable = false
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

type ExecError = Error & {
  code?: number | string;
  stderr?: string;
  stdout?: string;
};

interface DesktopContextCommand {
  cmd: 'list_windows' | 'inspect_window' | 'capture';
  id: string;
  params?: {
    windowId?: number;
    mode?: 'window' | 'screen';
    maxDepth?: number;
    maxNodes?: number;
  };
}

interface DesktopContextWindow {
  id: number;
  appName: string;
  pid: number;
  title: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  zOrder: number;
  stackIndex?: number;
  isOnScreen: boolean;
  isMinimized: boolean;
  isVisible: boolean;
  isFrontmostApp?: boolean;
  appIsHidden?: boolean;
  layer: number;
}

interface DesktopContextResponse {
  id: string;
  success: boolean;
  error?: string;
  data?: {
    windows?: DesktopContextWindow[];
    tree?: unknown;
    imagePath?: string;
    region?: { x: number; y: number; width: number; height: number };
  };
}

interface PendingRequest {
  resolve: (value: DesktopContextResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface WindowContextRecord {
  window: DesktopContextWindow;
  captureState: WindowCaptureState;
  capturedAt: string;
  imageBase64?: string;
  imageMimeType?: 'image/png';
  imageBytes?: number;
  imageWidth?: number;
  imageHeight?: number;
  errorCode?: ErrorCode;
  error?: string;
  fingerprint: string;
}

interface BackgroundSnapshot {
  capturedAt: string;
  refreshedAtMs: number;
  windows: WindowContextRecord[];
}

interface BackgroundContextArgs {
  include_images?: boolean;
  include_ax?: boolean;
  window_ids?: number[];
  force_refresh?: boolean;
}

interface ListWindowsArgs {
  include_minimized?: boolean;
  include_offscreen?: boolean;
}

interface CaptureSelectionContext {
  foregroundAppName: string | null;
  topWindowId: number | null;
}

interface WindowImageLimits {
  maxBytes: number;
  maxDimension: number;
}

interface BuildWindowContextOptions {
  imageLimits?: WindowImageLimits;
}

const BACKGROUND_IMAGE_LIMITS: WindowImageLimits = {
  maxBytes: BACKGROUND_MAX_WINDOW_IMAGE_BYTES,
  maxDimension: BACKGROUND_MAX_IMAGE_DIMENSION,
};

const TARGET_IMAGE_LIMITS: WindowImageLimits = {
  maxBytes: TARGET_WINDOW_IMAGE_BYTES,
  maxDimension: TARGET_IMAGE_DIMENSION,
};

// Temporary directory for screenshots
const TEMP_DIR = path.join(os.tmpdir(), 'screen-agent-captures');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup errors and preserve the original failure.
  }
}

function getExecErrorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error).toLowerCase();
  }

  const execError = error as ExecError;
  return `${execError.message ?? ''} ${execError.stderr ?? ''} ${execError.stdout ?? ''}`.toLowerCase();
}

function getExecExitCode(error: unknown): number | string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  return (error as ExecError).code;
}

function isPermissionDeniedCaptureError(error: unknown): boolean {
  const message = getExecErrorText(error);
  const indicators = [
    'not authorized',
    'permission denied',
    'operation not permitted',
    'screen recording',
  ];
  return indicators.some((indicator) => message.includes(indicator));
}

function isCommandNotFoundCaptureError(error: unknown): boolean {
  const message = getExecErrorText(error);
  const indicators = ['not found', 'enoent'];
  return indicators.some((indicator) => message.includes(indicator));
}

function isTransientCaptureError(error: unknown): boolean {
  const message = getExecErrorText(error);
  const indicators = [
    'resource temporarily unavailable',
    'temporarily unavailable',
    'timeout',
    'timed out',
    'interrupted system call',
    'failed to capture',
    'could not create image from display',
    'device busy',
  ];
  return indicators.some((indicator) => message.includes(indicator));
}

function normalizeCaptureError(error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }

  if (isPermissionDeniedCaptureError(error)) {
    return new ToolError(
      'ERR_CAPTURE_PERMISSION_DENIED',
      'Screen capture permission denied. Enable Screen Recording permission and retry.'
    );
  }

  if (isCommandNotFoundCaptureError(error)) {
    return new ToolError(
      'ERR_CAPTURE_COMMAND_FAILED',
      'Screen capture command is unavailable.'
    );
  }

  if (isTransientCaptureError(error)) {
    return new ToolError(
      'ERR_CAPTURE_COMMAND_FAILED',
      'Transient screen capture failure.',
      true
    );
  }

  if (getExecExitCode(error) !== undefined) {
    return new ToolError(
      'ERR_CAPTURE_COMMAND_FAILED',
      'Screen capture command failed.'
    );
  }

  return new ToolError('ERR_INTERNAL', 'Unexpected internal error.');
}

function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }
  return new ToolError('ERR_INTERNAL', 'Unexpected internal error.');
}

function formatToolError(error: unknown): string {
  const toolError = toToolError(error);
  return `${toolError.code}|${toolError.message}`;
}

function parseHelperError(errorMessage: string): ToolError {
  const value = errorMessage.toLowerCase();
  if (value.includes('screen recording permissions')) {
    return new ToolError(
      'ERR_DESKTOP_CONTEXT_PERMISSION_DENIED',
      'Desktop context capture requires Screen Recording permission for Screen Agent.'
    );
  }
  if (value.includes('accessibility permissions')) {
    return new ToolError(
      'ERR_DESKTOP_CONTEXT_ACCESSIBILITY_DENIED',
      'Desktop context inspection requires Accessibility permission for Screen Agent.'
    );
  }
  if (value.includes('window not found')) {
    return new ToolError(
      'ERR_DESKTOP_CONTEXT_WINDOW_NOT_FOUND',
      'Requested window was not found.'
    );
  }
  if (value.includes('missing parameter') || value.includes('invalid parameters')) {
    return new ToolError('ERR_INVALID_INPUT', errorMessage);
  }
  return new ToolError('ERR_DESKTOP_CONTEXT_PROTOCOL', errorMessage);
}

function normalizeHelperFailure(error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error;
  }

  if (error instanceof Error) {
    return parseHelperError(error.message);
  }

  return new ToolError('ERR_DESKTOP_CONTEXT_PROTOCOL', String(error));
}

class DesktopContextHelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private requestCounter = 0;
  private pending = new Map<string, PendingRequest>();
  private stdoutBuffer = '';

  private resolveHelperSpec(): { command: string; args: string[]; helperPath: string } {
    const helperPath = process.env.DESKTOP_CONTEXT_HELPER_PATH;
    if (!helperPath) {
      throw new ToolError(
        'ERR_DESKTOP_CONTEXT_UNAVAILABLE',
        'Desktop context helper path is not configured. Set DESKTOP_CONTEXT_HELPER_PATH.'
      );
    }

    if (!fs.existsSync(helperPath)) {
      throw new ToolError(
        'ERR_DESKTOP_CONTEXT_UNAVAILABLE',
        `Desktop context helper not found at ${helperPath}.`
      );
    }

    if (helperPath.endsWith('.swift')) {
      const swiftCommand = process.env.DESKTOP_CONTEXT_SWIFT_COMMAND || 'swift';
      return {
        command: swiftCommand,
        args: [helperPath],
        helperPath,
      };
    }

    return {
      command: helperPath,
      args: [],
      helperPath,
    };
  }

  private startProcess(): void {
    if (this.child) {
      return;
    }

    const helperSpec = this.resolveHelperSpec();

    this.child = spawn(helperSpec.command, helperSpec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        this.handleResponse(trimmed);
      }
    });

    this.child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) {
        console.error(`[desktop-context-helper] ${text}`);
      }
    });

    this.child.on('error', (error) => {
      this.rejectAllPending(
        new ToolError('ERR_DESKTOP_CONTEXT_HELPER_EXITED', `Desktop context helper error: ${error.message}`)
      );
      this.child = null;
    });

    this.child.on('exit', (code, signal) => {
      const reason = `Desktop context helper exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      this.rejectAllPending(new ToolError('ERR_DESKTOP_CONTEXT_HELPER_EXITED', reason));
      this.child = null;
    });
  }

  private rejectAllPending(error: ToolError): void {
    for (const [requestId, request] of this.pending.entries()) {
      clearTimeout(request.timeout);
      request.reject(error);
      this.pending.delete(requestId);
    }
  }

  private handleResponse(line: string): void {
    let response: DesktopContextResponse;
    try {
      response = JSON.parse(line) as DesktopContextResponse;
    } catch {
      console.error('[desktop-context-helper] Invalid JSON response:', line);
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);

    if (!response.success) {
      pending.reject(parseHelperError(response.error ?? 'Unknown helper error'));
      return;
    }

    pending.resolve(response);
  }

  async send(command: DesktopContextCommand): Promise<DesktopContextResponse> {
    this.startProcess();

    if (!this.child || !this.child.stdin.writable) {
      throw new ToolError(
        'ERR_DESKTOP_CONTEXT_UNAVAILABLE',
        'Desktop context helper is not available.'
      );
    }

    return await new Promise<DesktopContextResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(command.id);
        reject(
          new ToolError(
            'ERR_DESKTOP_CONTEXT_TIMEOUT',
            `Desktop context helper request timed out after ${HELPER_REQUEST_TIMEOUT_MS}ms.`
          )
        );
      }, HELPER_REQUEST_TIMEOUT_MS);

      this.pending.set(command.id, {
        resolve,
        reject,
        timeout,
      });

      try {
        this.child?.stdin.write(`${JSON.stringify(command)}\n`, 'utf8');
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(command.id);
        reject(normalizeHelperFailure(error));
      }
    });
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1;
    return `${prefix}_${Date.now()}_${this.requestCounter}`;
  }

  async listWindows(): Promise<DesktopContextWindow[]> {
    const response = await this.send({
      cmd: 'list_windows',
      id: this.nextRequestId('list'),
    });

    return response.data?.windows ?? [];
  }

  async captureWindow(windowId: number): Promise<{ imagePath: string }> {
    const response = await this.send({
      cmd: 'capture',
      id: this.nextRequestId('capture_window'),
      params: {
        mode: 'window',
        windowId,
      },
    });

    const imagePath = response.data?.imagePath;
    if (!imagePath) {
      throw new ToolError(
        'ERR_DESKTOP_CONTEXT_PROTOCOL',
        'Desktop context helper did not return an imagePath for capture.'
      );
    }

    return { imagePath };
  }

  async inspectWindow(windowId: number, maxDepth: number, maxNodes: number): Promise<unknown> {
    const response = await this.send({
      cmd: 'inspect_window',
      id: this.nextRequestId('inspect'),
      params: {
        windowId,
        maxDepth,
        maxNodes,
      },
    });

    return response.data?.tree ?? null;
  }

  dispose(): void {
    this.rejectAllPending(
      new ToolError('ERR_DESKTOP_CONTEXT_HELPER_EXITED', 'Desktop context helper is shutting down.')
    );

    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

const desktopContextHelper = new DesktopContextHelperClient();

const backgroundCache: {
  snapshot: BackgroundSnapshot | null;
  refreshPromise: Promise<BackgroundSnapshot> | null;
} = {
  snapshot: null,
  refreshPromise: null,
};

function buildWindowFingerprint(window: DesktopContextWindow): string {
  return [
    window.id,
    window.appName,
    window.title,
    window.bounds.x,
    window.bounds.y,
    window.bounds.width,
    window.bounds.height,
    window.zOrder,
    window.stackIndex ?? '',
    window.isOnScreen,
    window.isMinimized,
    window.isVisible,
    window.isFrontmostApp ?? '',
    window.appIsHidden ?? '',
    window.layer,
  ].join('|');
}

function deriveCaptureState(window: DesktopContextWindow): WindowCaptureState {
  if (window.isMinimized) {
    return 'minimized';
  }
  if (!window.isOnScreen || !window.isVisible || window.appIsHidden) {
    return 'offscreen';
  }
  return 'capturable';
}

function buildSelectionContext(windows: DesktopContextWindow[]): CaptureSelectionContext {
  const active = windows.filter((window) => !window.isMinimized);
  if (active.length === 0) {
    return {
      foregroundAppName: null,
      topWindowId: null,
    };
  }

  const topWindow = [...active].sort((a, b) => b.zOrder - a.zOrder)[0];
  const explicitFrontmost = active.find((window) => window.isFrontmostApp === true);

  return {
    foregroundAppName: explicitFrontmost?.appName ?? topWindow?.appName ?? null,
    topWindowId: topWindow?.id ?? null,
  };
}

function isBackgroundWindow(
  window: DesktopContextWindow,
  context: CaptureSelectionContext
): boolean {
  if (window.isMinimized) {
    return true;
  }

  if (!window.isOnScreen || !window.isVisible || window.appIsHidden) {
    return true;
  }

  if (window.isFrontmostApp === false) {
    return true;
  }

  if (context.foregroundAppName) {
    return window.appName !== context.foregroundAppName;
  }

  if (context.topWindowId !== null) {
    return window.id !== context.topWindowId;
  }

  return true;
}

function windowCapturePriority(
  window: DesktopContextWindow,
  context: CaptureSelectionContext
): number {
  const hasTitle = window.title.trim().length > 0;
  const background = isBackgroundWindow(window, context) ? 1 : 0;
  const onScreen = window.isOnScreen ? 1 : 0;
  const visible = window.isVisible ? 1 : 0;
  const appHidden = window.appIsHidden ? 1 : 0;
  const active = window.isMinimized ? 0 : 1;
  const area = Math.max(0, window.bounds.width) * Math.max(0, window.bounds.height);
  const areaScore = Math.min(Math.floor(area / 10000), 120);

  return (
    (hasTitle ? 200 : 0) +
    (background * 170) +
    (appHidden * 40) +
    areaScore +
    (onScreen * 20) +
    (visible * 20) +
    (active * 20) +
    window.zOrder
  );
}

function selectCaptureWindowIds(windows: DesktopContextWindow[]): Set<number> {
  const context = buildSelectionContext(windows);
  const ranked = [...windows]
    .filter((window) => deriveCaptureState(window) !== 'minimized')
    .sort((a, b) => windowCapturePriority(b, context) - windowCapturePriority(a, context));

  const selected: DesktopContextWindow[] = [];
  const selectedIds = new Set<number>();

  const backgroundPreferred = ranked
    .filter((window) => isBackgroundWindow(window, context) && window.title.trim().length > 0)
    .slice(0, MIN_BACKGROUND_WINDOWS_PER_REFRESH);

  for (const window of backgroundPreferred) {
    if (selectedIds.has(window.id)) {
      continue;
    }
    selected.push(window);
    selectedIds.add(window.id);
  }

  const foregroundPreferred = ranked
    .filter((window) => !isBackgroundWindow(window, context) && window.title.trim().length > 0)
    .slice(0, MIN_FOREGROUND_WINDOWS_PER_REFRESH);

  for (const window of foregroundPreferred) {
    if (selected.length >= MAX_CAPTURED_WINDOWS_PER_REFRESH || selectedIds.has(window.id)) {
      continue;
    }
    selected.push(window);
    selectedIds.add(window.id);
  }

  for (const window of ranked) {
    if (selected.length >= MAX_CAPTURED_WINDOWS_PER_REFRESH) {
      break;
    }
    if (selectedIds.has(window.id)) {
      continue;
    }
    selected.push(window);
    selectedIds.add(window.id);
  }

  return selectedIds;
}

async function getImageDimensions(
  filePath: string
): Promise<{ width?: number; height?: number }> {
  if (!SIPS_BIN) {
    return {};
  }

  const metadata = await execFileAsync(SIPS_BIN, ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath]);
  const widthMatch = metadata.stdout.match(/pixelWidth:\s*(\d+)/i);
  const heightMatch = metadata.stdout.match(/pixelHeight:\s*(\d+)/i);
  return {
    width: widthMatch ? Number(widthMatch[1]) : undefined,
    height: heightMatch ? Number(heightMatch[1]) : undefined,
  };
}

async function readWindowImage(
  filePath: string,
  limits: WindowImageLimits = BACKGROUND_IMAGE_LIMITS
): Promise<{
  imageBase64?: string;
  imageBytes: number;
  imageWidth?: number;
  imageHeight?: number;
  tooLarge: boolean;
}> {
  let width: number | undefined;
  let height: number | undefined;

  if (SIPS_BIN) {
    try {
      const dims = await getImageDimensions(filePath);
      width = dims.width;
      height = dims.height;

      if (
        typeof width === 'number' &&
        typeof height === 'number' &&
        (width > limits.maxDimension || height > limits.maxDimension)
      ) {
        await execFileAsync(SIPS_BIN, ['-Z', String(limits.maxDimension), filePath]);
        const resizedDims = await getImageDimensions(filePath);
        width = resizedDims.width ?? width;
        height = resizedDims.height ?? height;
      }
    } catch {
      // Ignore metadata/resize failures and continue with byte-size limits.
    }
  }

  let stats = fs.statSync(filePath);
  if (stats.size > limits.maxBytes && SIPS_BIN) {
    for (let attempt = 0; attempt < 3 && stats.size > limits.maxBytes; attempt += 1) {
      if (typeof width !== 'number' || typeof height !== 'number') {
        break;
      }
      const currentLongest = Math.max(width, height);
      if (!Number.isFinite(currentLongest) || currentLongest <= 400) {
        break;
      }

      const nextLongest = Math.max(400, Math.floor(currentLongest * 0.82));
      if (nextLongest >= currentLongest) {
        break;
      }

      try {
        await execFileAsync(SIPS_BIN, ['-Z', String(nextLongest), filePath]);
        const resizedDims = await getImageDimensions(filePath);
        width = resizedDims.width ?? width;
        height = resizedDims.height ?? height;
        stats = fs.statSync(filePath);
      } catch {
        break;
      }
    }
  }

  if (stats.size > limits.maxBytes) {
    return {
      imageBytes: stats.size,
      imageWidth: width,
      imageHeight: height,
      tooLarge: true,
    };
  }

  const buffer = fs.readFileSync(filePath);
  return {
    imageBase64: buffer.toString('base64'),
    imageBytes: buffer.length,
    imageWidth: width,
    imageHeight: height,
    tooLarge: false,
  };
}

async function buildWindowContext(
  window: DesktopContextWindow,
  options: BuildWindowContextOptions = {}
): Promise<WindowContextRecord> {
  const imageLimits = options.imageLimits ?? BACKGROUND_IMAGE_LIMITS;
  const defaultState = deriveCaptureState(window);
  const base: Omit<WindowContextRecord, 'fingerprint'> = {
    window,
    captureState: defaultState,
    capturedAt: new Date().toISOString(),
  };

  if (defaultState === 'minimized') {
    return {
      ...base,
      fingerprint: buildWindowFingerprint(window),
    };
  }

  let imagePath: string | undefined;
  try {
    const result = await desktopContextHelper.captureWindow(window.id);
    imagePath = result.imagePath;

    const image = await readWindowImage(imagePath, imageLimits);

    if (image.tooLarge) {
      return {
        ...base,
        captureState: 'capturable',
        imageBytes: image.imageBytes,
        imageWidth: image.imageWidth,
        imageHeight: image.imageHeight,
        errorCode: 'ERR_IMAGE_TOO_LARGE',
        error: `Window image exceeded ${imageLimits.maxBytes} bytes and was omitted.`,
        fingerprint: buildWindowFingerprint(window),
      };
    }

    const captureState = image.imageBytes <= TINY_IMAGE_BYTES ? 'protected_or_blank' : 'capturable';

    return {
      ...base,
      captureState,
      imageBase64: image.imageBase64,
      imageMimeType: 'image/png',
      imageBytes: image.imageBytes,
      imageWidth: image.imageWidth,
      imageHeight: image.imageHeight,
      fingerprint: buildWindowFingerprint(window),
    };
  } catch (error) {
    const toolError = normalizeHelperFailure(error);

    let captureState: WindowCaptureState = 'unknown';
    if (toolError.code === 'ERR_DESKTOP_CONTEXT_PERMISSION_DENIED') {
      captureState = 'permission_denied';
    } else if (toolError.code === 'ERR_DESKTOP_CONTEXT_WINDOW_NOT_FOUND') {
      captureState = 'not_found';
    } else if (toolError.code === 'ERR_DESKTOP_CONTEXT_ACCESSIBILITY_DENIED') {
      captureState = 'unknown';
    } else if (defaultState === 'offscreen') {
      captureState = 'offscreen';
    }

    return {
      ...base,
      captureState,
      errorCode: toolError.code,
      error: toolError.message,
      fingerprint: buildWindowFingerprint(window),
    };
  } finally {
    if (imagePath) {
      safeUnlink(imagePath);
    }
  }
}

function shouldReuseCachedContext(
  cached: WindowContextRecord | undefined,
  window: DesktopContextWindow
): boolean {
  if (!cached) {
    return false;
  }

  return cached.fingerprint === buildWindowFingerprint(window);
}

async function refreshBackgroundSnapshot(forceRefresh: boolean): Promise<BackgroundSnapshot> {
  const windows = await desktopContextHelper.listWindows();
  const captureWindowIds = selectCaptureWindowIds(windows);

  const previousById = new Map<number, WindowContextRecord>(
    backgroundCache.snapshot?.windows.map((entry) => [entry.window.id, entry]) ?? []
  );

  const capturedById = new Map<number, WindowContextRecord>();
  const captureTargets = windows.filter((window) => captureWindowIds.has(window.id));

  await Promise.all(
    captureTargets.map(async (window) => {
      const cached = previousById.get(window.id);
      if (!forceRefresh && cached && shouldReuseCachedContext(cached, window)) {
        capturedById.set(window.id, {
          ...cached,
          window,
        });
        return;
      }

      const context = await buildWindowContext(window);
      capturedById.set(window.id, context);
    })
  );

  const nextWindows: WindowContextRecord[] = [];

  for (const window of windows) {
    const shouldCapture = captureWindowIds.has(window.id);

    if (!shouldCapture) {
      const captureState = deriveCaptureState(window);
      nextWindows.push({
        window,
        captureState,
        capturedAt: new Date().toISOString(),
        fingerprint: buildWindowFingerprint(window),
      });
      continue;
    }

    const context = capturedById.get(window.id);
    if (context) {
      nextWindows.push(context);
      continue;
    }

    nextWindows.push({
      window,
      captureState: deriveCaptureState(window),
      capturedAt: new Date().toISOString(),
      errorCode: 'ERR_INTERNAL',
      error: 'Window capture context was not available.',
      fingerprint: buildWindowFingerprint(window),
    });
  }

  const snapshot: BackgroundSnapshot = {
    capturedAt: new Date().toISOString(),
    refreshedAtMs: Date.now(),
    windows: nextWindows,
  };

  backgroundCache.snapshot = snapshot;
  return snapshot;
}

async function getBackgroundSnapshot(forceRefresh: boolean): Promise<BackgroundSnapshot> {
  const snapshot = backgroundCache.snapshot;
  const isFresh =
    snapshot !== null &&
    Date.now() - snapshot.refreshedAtMs <= BACKGROUND_CACHE_TTL_MS;

  if (!forceRefresh && snapshot && isFresh) {
    return snapshot;
  }

  if (backgroundCache.refreshPromise) {
    return await backgroundCache.refreshPromise;
  }

  backgroundCache.refreshPromise = refreshBackgroundSnapshot(forceRefresh)
    .catch((error) => {
      throw normalizeHelperFailure(error);
    })
    .finally(() => {
      backgroundCache.refreshPromise = null;
    });

  return await backgroundCache.refreshPromise;
}

function startBackgroundSampler(): void {
  if (!process.env.DESKTOP_CONTEXT_HELPER_PATH) {
    console.error('[screen-capture] Desktop context helper path is not configured; background sampling disabled.');
    return;
  }

  const timer = setInterval(() => {
    void getBackgroundSnapshot(false).catch((error) => {
      const toolError = normalizeHelperFailure(error);
      console.error(`[screen-capture] background sampling failed: ${toolError.code}|${toolError.message}`);
    });
  }, BACKGROUND_SAMPLE_INTERVAL_MS);

  timer.unref?.();
}

async function getActiveWindowRegionArg(): Promise<string | null> {
  try {
    const { stdout: boundsInfo } = await execAsync(`
      osascript -e 'tell application "System Events"
        tell (first application process whose frontmost is true)
          tell (first window)
            return {position, size}
          end tell
        end tell
      end tell'
    `);

    const boundsMatch = boundsInfo.match(/(-?\d+),\s*(-?\d+).*?(\d+),\s*(\d+)/);
    if (!boundsMatch) {
      console.error(
        'ERR_CAPTURE_COMMAND_FAILED|Could not parse active window bounds, falling back to full-screen capture.'
      );
      return null;
    }

    const [, x, y, width, height] = boundsMatch;
    const numericWidth = Number(width);
    const numericHeight = Number(height);
    if (
      !Number.isFinite(numericWidth) ||
      !Number.isFinite(numericHeight) ||
      numericWidth <= 0 ||
      numericHeight <= 0
    ) {
      console.error(
        'ERR_CAPTURE_COMMAND_FAILED|Active window bounds were invalid, falling back to full-screen capture.'
      );
      return null;
    }

    return `-R${x},${y},${width},${height}`;
  } catch {
    console.error(
      'ERR_CAPTURE_COMMAND_FAILED|Active window lookup failed, falling back to full-screen capture.'
    );
    return null;
  }
}

/**
 * Capture a screenshot using macOS screencapture command
 */
async function captureScreen(options: {
  includeCursor?: boolean;
  activeWindowOnly?: boolean;
}): Promise<{ imageDataUrl: string; mode: CaptureMode }> {
  let regionArg = '';
  let mode: CaptureMode = 'full-screen';

  if (options.activeWindowOnly) {
    const activeWindowRegion = await getActiveWindowRegionArg();
    if (activeWindowRegion) {
      regionArg = ` ${activeWindowRegion}`;
      mode = 'active-window';
    }
  }

  for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES; attempt += 1) {
    const timestamp = Date.now();
    const filename = `screenshot_${timestamp}_${attempt}.png`;
    const filePath = path.join(TEMP_DIR, filename);

    let cmd = `${SCREENCAPTURE_BIN} -x`;
    if (options.includeCursor) {
      cmd += ' -C';
    }
    cmd += `${regionArg} "${filePath}"`;

    try {
      await execAsync(cmd);

      if (!fs.existsSync(filePath)) {
        throw new ToolError(
          'ERR_CAPTURE_OUTPUT_MISSING',
          'Capture output file was not created.',
          true
        );
      }

      const imageBuffer = fs.readFileSync(filePath);
      if (imageBuffer.length === 0) {
        throw new ToolError(
          'ERR_CAPTURE_OUTPUT_MISSING',
          'Capture output file was empty.',
          true
        );
      }

      return {
        imageDataUrl: `data:image/png;base64,${imageBuffer.toString('base64')}`,
        mode,
      };
    } catch (error) {
      const captureError = normalizeCaptureError(error);
      if (captureError.recoverable && attempt < CAPTURE_MAX_RETRIES) {
        await sleep(CAPTURE_RETRY_DELAY_MS * attempt);
        continue;
      }
      if (captureError.recoverable) {
        throw new ToolError(
          'ERR_CAPTURE_RETRY_EXHAUSTED',
          `Screen capture failed after ${CAPTURE_MAX_RETRIES} attempts.`
        );
      }
      throw captureError;
    } finally {
      safeUnlink(filePath);
    }
  }

  throw new ToolError(
    'ERR_CAPTURE_RETRY_EXHAUSTED',
    `Screen capture failed after ${CAPTURE_MAX_RETRIES} attempts.`
  );
}

/**
 * Get information about the current screen state
 */
async function getScreenInfo(): Promise<{
  activeApp: string;
  activeWindow: string;
  screenSize: { width: number; height: number };
  mousePosition: { x: number; y: number };
}> {
  try {
    const { stdout: appInfo } = await execAsync(`
      osascript -e 'tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        try
          set winTitle to name of first window of frontApp
        on error
          set winTitle to "No window"
        end try
        return appName & "|||" & winTitle
      end tell'
    `);

    const [activeApp, activeWindow] = appInfo.trim().split('|||');

    const { stdout: screenSize } = await execAsync(`
      osascript -e 'tell application "Finder" to get bounds of window of desktop'
    `);
    const screenMatch = screenSize.match(/(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
    const width = screenMatch ? parseInt(screenMatch[3]) : 1920;
    const height = screenMatch ? parseInt(screenMatch[4]) : 1080;

    let mouseX = 0;
    let mouseY = 0;

    try {
      const { stdout: mousePos } = await execAsync(`
        osascript -e 'tell application "System Events"
          set mousePos to do shell script "python3 -c \\\"import Quartz; loc = Quartz.NSEvent.mouseLocation(); print(int(loc.x), int(loc.y))\\\""
          return mousePos
        end tell'
      `);
      const mouseParts = mousePos.trim().split(' ');
      if (mouseParts.length >= 2) {
        mouseX = parseInt(mouseParts[0]);
        mouseY = height - parseInt(mouseParts[1]);
      }
    } catch {
      // Mouse position not available
    }

    return {
      activeApp: activeApp || 'Unknown',
      activeWindow: activeWindow || 'Unknown',
      screenSize: { width, height },
      mousePosition: { x: mouseX, y: mouseY },
    };
  } catch {
    throw new ToolError(
      'ERR_SCREEN_INFO_FAILED',
      'Unable to retrieve screen information.'
    );
  }
}

function toInt(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolError('ERR_INVALID_INPUT', `${fieldName} must be an integer.`);
  }
  return value;
}

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return defaultValue;
}

function parseWindowIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const ids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) {
      throw new ToolError('ERR_INVALID_INPUT', 'window_ids must be an array of integer window IDs.');
    }
    ids.push(entry);
  }

  return ids;
}

function filterWindows(
  windows: DesktopContextWindow[],
  options: { includeMinimized: boolean; includeOffscreen: boolean }
): DesktopContextWindow[] {
  return windows.filter((window) => {
    if (!options.includeMinimized && window.isMinimized) {
      return false;
    }

    if (!options.includeOffscreen && (!window.isOnScreen || !window.isVisible || window.appIsHidden)) {
      return false;
    }

    return true;
  });
}

function buildWindowSummary(
  record: WindowContextRecord,
  context?: CaptureSelectionContext
): Record<string, unknown> {
  return {
    id: record.window.id,
    appName: record.window.appName,
    pid: record.window.pid,
    title: record.window.title,
    bounds: record.window.bounds,
    zOrder: record.window.zOrder,
    stackIndex: record.window.stackIndex,
    isOnScreen: record.window.isOnScreen,
    isMinimized: record.window.isMinimized,
    isVisible: record.window.isVisible,
    isFrontmostApp: record.window.isFrontmostApp,
    appIsHidden: record.window.appIsHidden,
    isBackground: context ? isBackgroundWindow(record.window, context) : undefined,
    layer: record.window.layer,
    captureState: record.captureState,
    capturedAt: record.capturedAt,
    imageBytes: record.imageBytes,
    imageWidth: record.imageWidth,
    imageHeight: record.imageHeight,
    errorCode: record.errorCode,
    error: record.error,
  };
}

function buildWindowMetadataOnly(
  window: DesktopContextWindow,
  context?: CaptureSelectionContext
): Record<string, unknown> {
  return {
    id: window.id,
    appName: window.appName,
    pid: window.pid,
    title: window.title,
    bounds: window.bounds,
    zOrder: window.zOrder,
    stackIndex: window.stackIndex,
    isOnScreen: window.isOnScreen,
    isMinimized: window.isMinimized,
    isVisible: window.isVisible,
    isFrontmostApp: window.isFrontmostApp,
    appIsHidden: window.appIsHidden,
    isBackground: context ? isBackgroundWindow(window, context) : undefined,
    layer: window.layer,
    captureState: deriveCaptureState(window),
  };
}

function getWindowById(
  windows: DesktopContextWindow[],
  windowId: number
): DesktopContextWindow | undefined {
  return windows.find((entry) => entry.id === windowId);
}

// Create MCP server
const server = new Server(
  { name: 'screen-capture', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'capture_screen',
      description:
        'Capture a screenshot of the entire screen or active window. Returns a base64-encoded PNG image.',
      inputSchema: {
        type: 'object',
        properties: {
          include_cursor: {
            type: 'boolean',
            description: 'Whether to include the mouse cursor in the screenshot',
            default: true,
          },
          active_window_only: {
            type: 'boolean',
            description: 'If true, capture only the active/frontmost window instead of the entire screen',
            default: false,
          },
        },
        required: [],
      },
    },
    {
      name: 'get_screen_info',
      description:
        'Get information about the current screen state: active application, window title, screen size, and mouse position.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'list_windows',
      description:
        'List windows across applications, including background windows, with metadata and capture state.',
      inputSchema: {
        type: 'object',
        properties: {
          include_minimized: {
            type: 'boolean',
            description: 'Include minimized windows in the response.',
            default: true,
          },
          include_offscreen: {
            type: 'boolean',
            description: 'Include windows that are offscreen or currently not visible.',
            default: true,
          },
        },
        required: [],
      },
    },
    {
      name: 'capture_window',
      description:
        'Capture a specific window by CGWindowID and return image + metadata if available.',
      inputSchema: {
        type: 'object',
        properties: {
          window_id: {
            type: 'number',
            description: 'Window identifier returned by list_windows.',
          },
        },
        required: ['window_id'],
      },
    },
    {
      name: 'inspect_window',
      description:
        'Inspect a window accessibility tree by window ID. Requires Accessibility permission.',
      inputSchema: {
        type: 'object',
        properties: {
          window_id: {
            type: 'number',
            description: 'Window identifier returned by list_windows.',
          },
          max_depth: {
            type: 'number',
            description: 'Maximum accessibility traversal depth.',
            default: 10,
          },
          max_nodes: {
            type: 'number',
            description: 'Maximum accessibility node count.',
            default: 1000,
          },
        },
        required: ['window_id'],
      },
    },
    {
      name: 'get_background_context',
      description:
        'Return cached background window context (metadata + optional images + optional accessibility trees).',
      inputSchema: {
        type: 'object',
        properties: {
          include_images: {
            type: 'boolean',
            description: 'Include captured window images in result content.',
            default: true,
          },
          include_ax: {
            type: 'boolean',
            description: 'Include accessibility trees for selected windows.',
            default: false,
          },
          window_ids: {
            type: 'array',
            description: 'Optional subset of window IDs to include.',
            items: {
              type: 'number',
            },
          },
          force_refresh: {
            type: 'boolean',
            description: 'Force immediate recapture instead of using cache.',
            default: false,
          },
        },
        required: [],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(
  CallToolRequestSchema,
  async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'capture_screen') {
        const includeCursor =
          (args as { include_cursor?: boolean })?.include_cursor ?? true;
        const activeWindowOnly =
          (args as { active_window_only?: boolean })?.active_window_only ??
          false;

        const screenshot = await captureScreen({
          includeCursor,
          activeWindowOnly,
        });

        return {
          content: [
            {
              type: 'image',
              data: screenshot.imageDataUrl.replace('data:image/png;base64,', ''),
              mimeType: 'image/png',
            },
            {
              type: 'text',
              text: `Screenshot captured successfully (${screenshot.mode === 'active-window' ? 'active window only' : 'full screen'})`,
            },
          ],
        };
      }

      if (name === 'get_screen_info') {
        const info = await getScreenInfo();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(info, null, 2),
            },
          ],
        };
      }

      if (name === 'list_windows') {
        const parsedArgs = (args ?? {}) as ListWindowsArgs;
        const includeMinimized = parseBoolean(parsedArgs.include_minimized, true);
        const includeOffscreen = parseBoolean(parsedArgs.include_offscreen, true);

        const windows = await desktopContextHelper.listWindows();
        const filtered = filterWindows(windows, {
          includeMinimized,
          includeOffscreen,
        });
        const selectionContext = buildSelectionContext(filtered);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  timestamp: new Date().toISOString(),
                  count: filtered.length,
                  foregroundAppName: selectionContext.foregroundAppName,
                  windows: filtered.map((window) => buildWindowMetadataOnly(window, selectionContext)),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (name === 'capture_window') {
        const windowId = toInt((args as { window_id?: unknown })?.window_id, 'window_id');

        const windows = await desktopContextHelper.listWindows();
        const target = getWindowById(windows, windowId);

        if (!target) {
          throw new ToolError(
            'ERR_DESKTOP_CONTEXT_WINDOW_NOT_FOUND',
            `Window ${windowId} was not found. Run list_windows and retry.`
          );
        }

        const context = await buildWindowContext(target, {
          imageLimits: TARGET_IMAGE_LIMITS,
        });
        const selectionContext = buildSelectionContext(windows);
        const content: CallToolResult['content'] = [];

        if (context.imageBase64) {
          content.push({
            type: 'image',
            data: context.imageBase64,
            mimeType: context.imageMimeType ?? 'image/png',
          });
        }

        content.push({
          type: 'text',
          text: JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              foregroundAppName: selectionContext.foregroundAppName,
              window: buildWindowSummary(context, selectionContext),
              hasImage: Boolean(context.imageBase64),
            },
            null,
            2
          ),
        });

        return { content };
      }

      if (name === 'inspect_window') {
        const windowId = toInt((args as { window_id?: unknown })?.window_id, 'window_id');
        const maxDepthRaw = (args as { max_depth?: unknown })?.max_depth;
        const maxNodesRaw = (args as { max_nodes?: unknown })?.max_nodes;

        const maxDepth =
          typeof maxDepthRaw === 'number' && Number.isInteger(maxDepthRaw)
            ? Math.min(Math.max(maxDepthRaw, 1), 20)
            : 10;

        const maxNodes =
          typeof maxNodesRaw === 'number' && Number.isInteger(maxNodesRaw)
            ? Math.min(Math.max(maxNodesRaw, 1), 5000)
            : 1000;

        const tree = await desktopContextHelper.inspectWindow(windowId, maxDepth, maxNodes);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  timestamp: new Date().toISOString(),
                  windowId,
                  maxDepth,
                  maxNodes,
                  tree,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (name === 'get_background_context') {
        const parsedArgs = (args ?? {}) as BackgroundContextArgs;
        const includeImages = parseBoolean(parsedArgs.include_images, true);
        const includeAx = parseBoolean(parsedArgs.include_ax, false);
        const forceRefresh = parseBoolean(parsedArgs.force_refresh, false);
        const requestedWindowIds = parseWindowIds(parsedArgs.window_ids);

        const snapshot = await getBackgroundSnapshot(forceRefresh);

        let selected = requestedWindowIds
          ? snapshot.windows.filter((window) => requestedWindowIds.includes(window.window.id))
          : snapshot.windows;

        if (includeImages && requestedWindowIds && requestedWindowIds.length > 0) {
          const refreshedSelected: WindowContextRecord[] = [];
          for (const entry of selected) {
            if (typeof entry.imageBase64 === 'string' || entry.captureState === 'minimized') {
              refreshedSelected.push(entry);
              continue;
            }

            try {
              refreshedSelected.push(
                await buildWindowContext(entry.window, {
                  imageLimits: TARGET_IMAGE_LIMITS,
                })
              );
            } catch {
              refreshedSelected.push(entry);
            }
          }
          selected = refreshedSelected;
        }

        const accessibilityTrees: Record<number, unknown> = {};
        if (includeAx) {
          for (const entry of selected) {
            try {
              accessibilityTrees[entry.window.id] = await desktopContextHelper.inspectWindow(
                entry.window.id,
                10,
                1000
              );
            } catch (error) {
              const toolError = normalizeHelperFailure(error);
              accessibilityTrees[entry.window.id] = {
                errorCode: toolError.code,
                error: toolError.message,
              };
            }
          }
        }

        const content: CallToolResult['content'] = [];
        const selectionContext = buildSelectionContext(selected.map((entry) => entry.window));
        const backgroundEntries = selected.filter((entry) =>
          isBackgroundWindow(entry.window, selectionContext)
        );

        const imageEntries = includeImages
          ? selected.filter((entry) => typeof entry.imageBase64 === 'string')
          : [];
        const orderedImageEntries = [...imageEntries].sort((a, b) => {
          if (requestedWindowIds && requestedWindowIds.length > 0) {
            const aIndex = requestedWindowIds.indexOf(a.window.id);
            const bIndex = requestedWindowIds.indexOf(b.window.id);
            const aRank = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
            const bRank = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
            return aRank - bRank;
          }

          const aBackground = isBackgroundWindow(a.window, selectionContext) ? 1 : 0;
          const bBackground = isBackgroundWindow(b.window, selectionContext) ? 1 : 0;
          if (aBackground !== bBackground) {
            return bBackground - aBackground;
          }

          const aArea = Math.max(0, a.window.bounds.width) * Math.max(0, a.window.bounds.height);
          const bArea = Math.max(0, b.window.bounds.width) * Math.max(0, b.window.bounds.height);
          if (aArea !== bArea) {
            return bArea - aArea;
          }

          return b.window.zOrder - a.window.zOrder;
        });
        const recommendedBackgroundWindowIds = [
          ...backgroundEntries
            .filter((entry) => typeof entry.imageBase64 === 'string')
            .map((entry) => entry.window.id),
          ...backgroundEntries
            .filter((entry) => typeof entry.imageBase64 !== 'string')
            .map((entry) => entry.window.id),
        ].slice(0, MAX_CAPTURED_WINDOWS_PER_REFRESH);

        if (includeImages) {
          for (const entry of orderedImageEntries) {
            content.push({
              type: 'image',
              data: entry.imageBase64!,
              mimeType: entry.imageMimeType ?? 'image/png',
            });
          }
        }

        content.push({
          type: 'text',
          text: JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              cachedAt: snapshot.capturedAt,
              fromCache: !forceRefresh,
              sampleIntervalMs: BACKGROUND_SAMPLE_INTERVAL_MS,
              foregroundAppName: selectionContext.foregroundAppName,
              windows: selected.map((entry) => ({
                ...buildWindowSummary(entry, selectionContext),
                hasImage: Boolean(includeImages && entry.imageBase64),
              })),
              images: orderedImageEntries.map((entry, index) => ({
                contentIndex: index,
                windowId: entry.window.id,
                appName: entry.window.appName,
                title: entry.window.title,
              })),
              imageCaptureBudget: MAX_CAPTURED_WINDOWS_PER_REFRESH,
              backgroundWindowCount: backgroundEntries.length,
              recommendedBackgroundWindowIds,
              windowsWithoutImages: includeImages ? selected.length - orderedImageEntries.length : undefined,
              accessibilityTrees: includeAx ? accessibilityTrees : undefined,
            },
            null,
            2
          ),
        });

        return { content };
      }

      return {
        content: [{ type: 'text', text: `ERR_UNKNOWN_TOOL|Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: formatToolError(error) }],
        isError: true,
      };
    }
  }
);

// Start the MCP server
async function main() {
  startBackgroundSampler();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Screen Capture MCP Server started');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

process.on('exit', () => {
  desktopContextHelper.dispose();
});

process.on('SIGINT', () => {
  desktopContextHelper.dispose();
  process.exit(0);
});

process.on('SIGTERM', () => {
  desktopContextHelper.dispose();
  process.exit(0);
});
