/**
 * Desktop Context Service
 * 
 * Manages communication with the macOS native helper for window enumeration,
 * accessibility inspection, and screenshot capture.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import type {
  DesktopWindow,
  AccessibleNode,
  DesktopScreenshot,
  DesktopContextOptions,
} from '@accomplish/shared';
import type {
  DesktopContextCommand,
  DesktopContextResponse,
  DesktopContextErrorCode,
} from './desktop-context-protocol';

const REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const HELPER_RESTART_DELAY_MS = 1000;
const MAX_ACCESSIBILITY_DEPTH = 20; // Maximum depth for accessibility tree
const MAX_ACCESSIBILITY_NODES = 5000; // Maximum nodes in accessibility tree
const MAX_SCREENSHOT_SIZE_MB = 50; // Maximum screenshot file size (MB)

interface PendingRequest {
  resolve: (response: DesktopContextResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class DesktopContextService {
  private helperProcess: ChildProcess | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestIdCounter = 0;
  private isShuttingDown = false;
  private restartAttempts = 0;
  private readonly maxRestartAttempts = 3;

  /**
   * Get the path to the native helper binary
   */
  private getHelperPath(): string {
    if (app.isPackaged) {
      // In packaged app, helper should be in resources
      return path.join(process.resourcesPath, 'desktop-context-helper');
    } else {
      // In development, use the Swift script directly
      return path.join(__dirname, '../../../native/desktop-context-helper.swift');
    }
  }

  /**
   * Start the native helper process
   */
  private startHelper(): void {
    if (this.isShuttingDown || this.helperProcess) {
      return;
    }

    const helperPath = this.getHelperPath();

    // Check if helper exists
    if (!fs.existsSync(helperPath)) {
      console.warn('[DesktopContext] Helper not found at:', helperPath);
      console.warn('[DesktopContext] Desktop context features will be unavailable');
      return;
    }

    try {
      // Spawn the helper process
      const args = app.isPackaged ? [] : [helperPath];
      const command = app.isPackaged ? helperPath : 'swift';

      this.helperProcess = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      this.helperProcess.stdout?.setEncoding('utf8');
      this.helperProcess.stderr?.setEncoding('utf8');

      let buffer = '';

      this.helperProcess.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            this.handleResponse(line.trim());
          }
        }
      });

      this.helperProcess.stderr?.on('data', (data: string) => {
        console.error('[DesktopContext Helper]', data);
      });

      this.helperProcess.on('exit', (code, signal) => {
        console.log(`[DesktopContext] Helper exited with code ${code}, signal ${signal}`);
        this.helperProcess = null;

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests.entries()) {
          clearTimeout(pending.timeout);
          pending.reject(
            new Error(`Helper process exited before request ${id} completed`)
          );
        }
        this.pendingRequests.clear();

        // Restart if not shutting down and we haven't exceeded max attempts
        if (!this.isShuttingDown && this.restartAttempts < this.maxRestartAttempts) {
          this.restartAttempts++;
          console.log(`[DesktopContext] Restarting helper (attempt ${this.restartAttempts}/${this.maxRestartAttempts})`);
          setTimeout(() => {
            this.startHelper();
          }, HELPER_RESTART_DELAY_MS);
        }
      });

      this.helperProcess.on('error', (error) => {
        console.error('[DesktopContext] Helper process error:', error);
        this.helperProcess = null;
      });

      this.restartAttempts = 0; // Reset on successful start
      console.log('[DesktopContext] Helper process started');
    } catch (error) {
      console.error('[DesktopContext] Failed to start helper:', error);
      this.helperProcess = null;
    }
  }

  /**
   * Handle a response from the helper
   */
  private handleResponse(line: string): void {
    try {
      const response: DesktopContextResponse = JSON.parse(line);

      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.id);
        pending.resolve(response);
      } else {
        console.warn('[DesktopContext] Received response for unknown request:', response.id);
      }
    } catch (error) {
      console.error('[DesktopContext] Failed to parse response:', error, line);
    }
  }

  /**
   * Send a command to the helper and wait for response
   */
  private async sendCommand(command: DesktopContextCommand): Promise<DesktopContextResponse> {
    // Ensure helper is running
    if (!this.helperProcess || this.helperProcess.killed) {
      this.startHelper();
      // Wait a bit for helper to start
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!this.helperProcess || this.helperProcess.killed) {
      throw new Error('Helper process is not available');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(command.id);
        reject(new Error(`Request ${command.id} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(command.id, { resolve, reject, timeout });

      try {
        const json = JSON.stringify(command) + '\n';
        this.helperProcess?.stdin?.write(json, 'utf8');
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(command.id);
        reject(error);
      }
    });
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${++this.requestIdCounter}`;
  }

  /**
   * List all windows
   */
  async listWindows(): Promise<DesktopWindow[]> {
    const command: DesktopContextCommand = {
      cmd: 'list_windows',
      id: this.generateRequestId(),
    };

    const response = await this.sendCommand(command);

    if (!response.success) {
      throw new Error(response.error || 'Failed to list windows');
    }

    return (
      response.data?.windows?.map((w) => ({
        id: w.id,
        appName: w.appName,
        pid: w.pid,
        title: w.title,
        bounds: {
          x: w.bounds.x,
          y: w.bounds.y,
          width: w.bounds.width,
          height: w.bounds.height,
        },
        zOrder: w.zOrder,
        isOnScreen: w.isOnScreen,
        isMinimized: w.isMinimized,
        isVisible: w.isVisible,
        layer: w.layer,
      })) || []
    );
  }

  /**
   * Inspect a window's accessibility tree
   */
  async inspectWindow(
    windowId: number,
    maxDepth = 10,
    maxNodes = 1000
  ): Promise<AccessibleNode> {
    // Enforce limits
    const depth = Math.min(maxDepth, MAX_ACCESSIBILITY_DEPTH);
    const nodes = Math.min(maxNodes, MAX_ACCESSIBILITY_NODES);
    const command: DesktopContextCommand = {
      cmd: 'inspect_window',
      id: this.generateRequestId(),
      params: {
        windowId,
        maxDepth: depth,
        maxNodes: nodes,
      },
    };

    const response = await this.sendCommand(command);

    if (!response.success) {
      throw new Error(response.error || 'Failed to inspect window');
    }

    if (!response.data?.tree) {
      throw new Error('No accessibility tree in response');
    }

    return this.mapAccessibleNode(response.data.tree);
  }

  /**
   * Map helper's accessible node to our type
   */
  private mapAccessibleNode(node: any): AccessibleNode {
    return {
      role: node.role,
      title: node.title,
      value: node.value,
      description: node.description,
      frame: node.frame
        ? {
            x: node.frame.x,
            y: node.frame.y,
            width: node.frame.width,
            height: node.frame.height,
          }
        : undefined,
      children: node.children?.map((child: any) => this.mapAccessibleNode(child)),
      actions: node.actions,
      enabled: node.enabled,
      focused: node.focused,
      windowId: node.windowId,
      appId: node.appId,
    };
  }

  /**
   * Capture a screenshot
   */
  async captureScreenshot(
    mode: 'screen' | 'window' | 'region',
    windowId?: number,
    rect?: { x: number; y: number; width: number; height: number }
  ): Promise<DesktopScreenshot> {
    const command: DesktopContextCommand = {
      cmd: 'capture',
      id: this.generateRequestId(),
      params: {
        mode,
        windowId,
        rect: rect
          ? {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            }
          : undefined,
      },
    };

    const response = await this.sendCommand(command);

    if (!response.success) {
      throw new Error(response.error || 'Failed to capture screenshot');
    }

    if (!response.data?.imagePath || !response.data?.region) {
      throw new Error('Invalid screenshot response');
    }

    // Check file size
    try {
      const stats = fs.statSync(response.data.imagePath);
      const sizeMB = stats.size / (1024 * 1024);
      if (sizeMB > MAX_SCREENSHOT_SIZE_MB) {
        // Delete oversized screenshot
        fs.unlinkSync(response.data.imagePath);
        throw new Error(`Screenshot too large: ${sizeMB.toFixed(2)}MB (max ${MAX_SCREENSHOT_SIZE_MB}MB)`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('too large')) {
        throw error;
      }
      // If stat fails, continue anyway (file might have been deleted)
      console.warn('[DesktopContext] Could not check screenshot size:', error);
    }

    return {
      id: `screenshot_${Date.now()}`,
      timestamp: new Date().toISOString(),
      region: {
        x: response.data.region.x,
        y: response.data.region.y,
        width: response.data.region.width,
        height: response.data.region.height,
      },
      imagePath: response.data.imagePath,
      windowId,
    };
  }

  /**
   * Get desktop context snapshot
   */
  async getDesktopContext(options: DesktopContextOptions = {}): Promise<{
    windows: DesktopWindow[];
    accessibilityTrees?: Record<number, AccessibleNode>;
    screenshots?: DesktopScreenshot[];
  }> {
    const result: {
      windows: DesktopWindow[];
      accessibilityTrees?: Record<number, AccessibleNode>;
      screenshots?: DesktopScreenshot[];
    } = {
      windows: [],
    };

    // List windows if requested
    if (options.includeWindows !== false) {
      result.windows = await this.listWindows();
    }

    // Inspect windows if requested
    if (options.inspectWindowIds && options.inspectWindowIds.length > 0) {
      result.accessibilityTrees = {};
      const maxDepth = options.maxAccessibilityDepth ?? 10;
      const maxNodes = options.maxAccessibilityNodes ?? 1000;

      for (const windowId of options.inspectWindowIds) {
        try {
          const tree = await this.inspectWindow(windowId, maxDepth, maxNodes);
          result.accessibilityTrees[windowId] = tree;
        } catch (error) {
          console.warn(`[DesktopContext] Failed to inspect window ${windowId}:`, error);
        }
      }
    }

    // Capture screenshots if requested
    if (options.captureScreenshots) {
      result.screenshots = [];
      const mode = options.screenshotMode || 'screen';

      try {
        if (mode === 'screen') {
          const screenshot = await this.captureScreenshot('screen');
          result.screenshots.push(screenshot);
        } else if (mode === 'window' && options.screenshotWindowId) {
          const screenshot = await this.captureScreenshot('window', options.screenshotWindowId);
          result.screenshots.push(screenshot);
        } else if (mode === 'region' && options.screenshotRegion) {
          const screenshot = await this.captureScreenshot('region', undefined, options.screenshotRegion);
          result.screenshots.push(screenshot);
        }
      } catch (error) {
        console.warn('[DesktopContext] Failed to capture screenshot:', error);
      }
    }

    return result;
  }

  /**
   * Initialize the service (start helper)
   */
  initialize(): void {
    if (!this.isShuttingDown) {
      this.startHelper();
    }
  }

  /**
   * Shutdown the service
   */
  shutdown(): void {
    this.isShuttingDown = true;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Service is shutting down'));
    }
    this.pendingRequests.clear();

    // Kill helper process
    if (this.helperProcess && !this.helperProcess.killed) {
      this.helperProcess.kill();
      this.helperProcess = null;
    }
  }
}

// Singleton instance
let serviceInstance: DesktopContextService | null = null;

/**
 * Get the desktop context service instance
 */
export function getDesktopContextService(): DesktopContextService {
  if (!serviceInstance) {
    serviceInstance = new DesktopContextService();
    serviceInstance.initialize();
  }
  return serviceInstance;
}
