/**
 * Desktop Context Background Polling Service
 * 
 * Periodically captures desktop context snapshots when enabled
 */

import { EventEmitter } from 'events';
import type { DesktopContextSnapshot, DesktopContextOptions } from '@accomplish/shared';
import { getDesktopContextService } from './desktop-context-service';
import {
  getAllowDesktopContext,
  getDesktopContextBackgroundPolling,
} from '../store/appSettings';

const DEFAULT_POLL_INTERVAL_MS = 5000; // 5 seconds
const MIN_POLL_INTERVAL_MS = 1000; // Minimum 1 second
const MAX_CONSECUTIVE_ERRORS = 5; // Stop polling after this many consecutive errors

export interface DesktopContextPollingOptions {
  /** Polling interval in milliseconds */
  intervalMs?: number;
  /** Options to pass to getDesktopContext */
  contextOptions?: DesktopContextOptions;
}

export class DesktopContextPollingService extends EventEmitter {
  private pollingInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private options: DesktopContextPollingOptions;
  private consecutiveErrors = 0;

  constructor(options: DesktopContextPollingOptions = {}) {
    super();
    this.options = {
      intervalMs: options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      contextOptions: options.contextOptions ?? {},
    };
  }

  /**
   * Start background polling
   */
  start(): void {
    if (this.isPolling) {
      return;
    }

    // Check if feature is enabled
    if (!getAllowDesktopContext() || !getDesktopContextBackgroundPolling()) {
      console.log('[DesktopContextPolling] Feature is disabled in settings');
      return;
    }

    this.isPolling = true;
    const intervalMs = Math.max(
      this.options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS
    );

    console.log(`[DesktopContextPolling] Starting with interval ${intervalMs}ms`);

    // Poll immediately, then set up interval
    this.poll();

    this.pollingInterval = setInterval(() => {
      this.poll();
    }, intervalMs);
  }

  /**
   * Stop background polling
   */
  stop(): void {
    if (!this.isPolling) {
      return;
    }

    this.isPolling = false;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    console.log('[DesktopContextPolling] Stopped');
  }

  /**
   * Perform a single poll
   */
  private async poll(): Promise<void> {
    // Re-check settings in case they changed
    if (!getAllowDesktopContext() || !getDesktopContextBackgroundPolling()) {
      this.stop();
      return;
    }

    try {
      const service = getDesktopContextService();
      const context = await service.getDesktopContext(this.options.contextOptions);

      const snapshot: DesktopContextSnapshot = {
        timestamp: new Date().toISOString(),
        windows: context.windows,
        accessibilityTrees: context.accessibilityTrees,
        screenshots: context.screenshots,
      };

      // Reset error counter on success
      this.consecutiveErrors = 0;
      this.emit('snapshot', snapshot);
    } catch (error) {
      this.consecutiveErrors++;
      console.error(`[DesktopContextPolling] Poll failed (${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error);
      this.emit('error', error);

      // Stop polling if too many consecutive errors
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error('[DesktopContextPolling] Too many consecutive errors, stopping polling');
        this.stop();
        this.emit('stopped', { reason: 'too_many_errors' });
      }
    }
  }

  /**
   * Update polling options
   */
  updateOptions(options: Partial<DesktopContextPollingOptions>): void {
    this.options = {
      ...this.options,
      ...options,
    };

    // Restart if currently polling
    if (this.isPolling) {
      this.stop();
      this.start();
    }
  }

  /**
   * Check if currently polling
   */
  isActive(): boolean {
    return this.isPolling;
  }
}

// Singleton instance
let pollingInstance: DesktopContextPollingService | null = null;

/**
 * Get the desktop context polling service instance
 */
export function getDesktopContextPollingService(): DesktopContextPollingService {
  if (!pollingInstance) {
    pollingInstance = new DesktopContextPollingService();
  }
  return pollingInstance;
}

/**
 * Initialize polling service (called when settings change)
 */
export function initializeDesktopContextPolling(): void {
  const polling = getDesktopContextPollingService();

  if (getAllowDesktopContext() && getDesktopContextBackgroundPolling()) {
    polling.start();
  } else {
    polling.stop();
  }
}
