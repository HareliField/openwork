#!/usr/bin/env node
/**
 * Screen Capture MCP Server
 *
 * Provides tools for capturing screenshots on macOS using the native
 * screencapture command. Also provides screen info like active app and window.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

const CAPTURE_MAX_RETRIES = 3;
const CAPTURE_RETRY_DELAY_MS = 250;
const SCREENCAPTURE_BIN = fs.existsSync('/usr/sbin/screencapture')
  ? '/usr/sbin/screencapture'
  : 'screencapture';

type CaptureMode = 'active-window' | 'full-screen';
type ErrorCode =
  | 'ERR_UNKNOWN_TOOL'
  | 'ERR_CAPTURE_PERMISSION_DENIED'
  | 'ERR_CAPTURE_COMMAND_FAILED'
  | 'ERR_CAPTURE_OUTPUT_MISSING'
  | 'ERR_CAPTURE_RETRY_EXHAUSTED'
  | 'ERR_SCREEN_INFO_FAILED'
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

// Temporary directory for screenshots
const TEMP_DIR = path.join(os.tmpdir(), 'screen-agent-captures');

// Ensure temp directory exists
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

    const boundsMatch = boundsInfo.match(/(\d+),\s*(\d+).*?(\d+),\s*(\d+)/);
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
 * @param options - Screenshot options
 * @returns Base64 encoded PNG image
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
    // Get active app and window title
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

    // Get screen size
    const { stdout: screenSize } = await execAsync(`
      osascript -e 'tell application "Finder" to get bounds of window of desktop'
    `);
    const screenMatch = screenSize.match(/(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
    const width = screenMatch ? parseInt(screenMatch[3]) : 1920;
    const height = screenMatch ? parseInt(screenMatch[4]) : 1080;

    // Get mouse position using cliclick if available, otherwise use AppleScript
    let mouseX = 0;
    let mouseY = 0;

    try {
      const { stdout: mousePos } = await execAsync(`
        osascript -e 'tell application "System Events"
          set mousePos to do shell script "python3 -c \\"import Quartz; loc = Quartz.NSEvent.mouseLocation(); print(int(loc.x), int(loc.y))\\""
          return mousePos
        end tell'
      `);
      const mouseParts = mousePos.trim().split(' ');
      if (mouseParts.length >= 2) {
        mouseX = parseInt(mouseParts[0]);
        // Flip Y coordinate (macOS has origin at bottom-left)
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

// Create MCP server
const server = new Server(
  { name: 'screen-capture', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'capture_screen',
      description:
        'Capture a screenshot of the entire screen or active window. Returns a base64-encoded PNG image that can be analyzed to see what the user is looking at.',
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
            description:
              'If true, capture only the active/frontmost window instead of the entire screen',
            default: false,
          },
        },
        required: [],
      },
    },
    {
      name: 'get_screen_info',
      description:
        'Get information about the current screen state: active application, window title, screen size, and mouse position. Useful for understanding context without taking a screenshot.',
      inputSchema: {
        type: 'object',
        properties: {},
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Screen Capture MCP Server started');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
