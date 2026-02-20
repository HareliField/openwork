/**
 * Smart Trigger Service
 *
 * Monitors user activity patterns on macOS to detect when the user might be stuck
 * and could benefit from help. Uses idle detection and activity monitoring.
 *
 * Triggers include:
 * - User has been idle for a configurable period after activity
 * - Repeated clicks in the same area (looking for something)
 * - Same keyboard shortcut pressed multiple times (trying to find a feature)
 */

import { app, BrowserWindow, powerMonitor, ipcMain } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface SmartTriggerConfig {
  /** Enable/disable smart triggers */
  enabled: boolean;
  /** Seconds of idle time after activity before suggesting help */
  idleThresholdSeconds: number;
  /** Minimum seconds of activity before idle detection kicks in */
  minActivitySeconds: number;
  /** How often to check for triggers (ms) */
  checkIntervalMs: number;
}

interface ActivityState {
  /** Last time we detected user activity */
  lastActivityTime: number;
  /** Time when the current activity session started */
  sessionStartTime: number;
  /** Whether we're currently in an "active" session */
  isActive: boolean;
  /** Last mouse position */
  lastMousePosition: { x: number; y: number } | null;
  /** Count of clicks in similar position */
  sameAreaClickCount: number;
  /** Whether we've already triggered for current session */
  hasTriggeredThisSession: boolean;
  /** Last time a trigger was emitted (global cooldown) */
  lastTriggerTime: number;
}

const DEFAULT_CONFIG: SmartTriggerConfig = {
  enabled: true,
  idleThresholdSeconds: 30, // 30 seconds idle after activity
  minActivitySeconds: 10, // At least 10 seconds of activity
  checkIntervalMs: 5000, // Check every 5 seconds
};

/** Minimum time between triggers in milliseconds (5 minutes) */
const TRIGGER_COOLDOWN_MS = 5 * 60 * 1000;

class SmartTriggerService {
  private config: SmartTriggerConfig;
  private state: ActivityState;
  private checkInterval: NodeJS.Timeout | null = null;
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.state = this.createInitialState();
  }

  private createInitialState(): ActivityState {
    return {
      lastActivityTime: Date.now(),
      sessionStartTime: Date.now(),
      isActive: false,
      lastMousePosition: null,
      sameAreaClickCount: 0,
      hasTriggeredThisSession: false,
      lastTriggerTime: 0,
    };
  }

  /**
   * Initialize the smart trigger service
   */
  initialize(window: BrowserWindow): void {
    this.mainWindow = window;

    // Listen for system idle state changes
    powerMonitor.on('suspend', () => {
      console.log('[SmartTrigger] System suspended');
      this.state.isActive = false;
    });

    powerMonitor.on('resume', () => {
      console.log('[SmartTrigger] System resumed');
      this.resetSession();
    });

    // Register IPC handlers for configuration
    this.registerIPCHandlers();

    // Start monitoring if enabled
    if (this.config.enabled) {
      this.startMonitoring();
    }

    console.log('[SmartTrigger] Service initialized');
  }

  /**
   * Register IPC handlers for smart trigger configuration
   */
  private registerIPCHandlers(): void {
    // Get current config
    ipcMain.handle('smart-trigger:get-config', () => {
      return this.config;
    });

    // Update config
    ipcMain.handle('smart-trigger:set-config', (_, config: Partial<SmartTriggerConfig>) => {
      this.config = { ...this.config, ...config };

      if (this.config.enabled && !this.checkInterval) {
        this.startMonitoring();
      } else if (!this.config.enabled && this.checkInterval) {
        this.stopMonitoring();
      }

      return this.config;
    });

    // Manual trigger (for testing)
    ipcMain.handle('smart-trigger:trigger', () => {
      this.emitTrigger('manual');
    });

    // User activity notification from renderer
    ipcMain.on('smart-trigger:activity', () => {
      this.onUserActivity();
    });
  }

  /**
   * Start monitoring for triggers
   */
  private startMonitoring(): void {
    if (this.checkInterval) return;

    console.log('[SmartTrigger] Starting monitoring');

    this.checkInterval = setInterval(() => {
      this.checkForTriggers();
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop monitoring
   */
  private stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('[SmartTrigger] Stopped monitoring');
    }
  }

  /**
   * Called when user activity is detected
   */
  onUserActivity(): void {
    const now = Date.now();

    if (!this.state.isActive) {
      // Starting a new activity session
      this.state.isActive = true;
      this.state.sessionStartTime = now;
      this.state.hasTriggeredThisSession = false;
      console.log('[SmartTrigger] Activity session started');
    }

    this.state.lastActivityTime = now;
  }

  /**
   * Check if we should trigger a help suggestion
   */
  private async checkForTriggers(): Promise<void> {
    if (!this.config.enabled || !this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    const now = Date.now();
    const idleTimeSeconds = (now - this.state.lastActivityTime) / 1000;
    const sessionDurationSeconds = (now - this.state.sessionStartTime) / 1000;
    const timeSinceLastTrigger = now - this.state.lastTriggerTime;

    // Check for idle trigger with global cooldown
    if (
      this.state.isActive &&
      !this.state.hasTriggeredThisSession &&
      timeSinceLastTrigger >= TRIGGER_COOLDOWN_MS &&
      sessionDurationSeconds >= this.config.minActivitySeconds &&
      idleTimeSeconds >= this.config.idleThresholdSeconds
    ) {
      console.log('[SmartTrigger] Idle trigger conditions met:', {
        idleTimeSeconds,
        sessionDurationSeconds,
      });

      // Check system idle time to confirm user is actually idle
      const systemIdleTime = await this.getSystemIdleTime();
      if (systemIdleTime >= this.config.idleThresholdSeconds) {
        this.emitTrigger('idle');
        this.state.hasTriggeredThisSession = true;
        this.state.lastTriggerTime = now;
      }
    }

    // Reset active state if idle for too long
    if (idleTimeSeconds > this.config.idleThresholdSeconds * 2) {
      this.state.isActive = false;
    }
  }

  /**
   * Get system idle time in seconds (macOS specific)
   */
  private async getSystemIdleTime(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        'ioreg -c IOHIDSystem | awk \'/HIDIdleTime/ {print $NF; exit}\''
      );
      // HIDIdleTime is in nanoseconds
      const idleNs = parseInt(stdout.trim(), 10);
      return idleNs / 1_000_000_000;
    } catch {
      return 0;
    }
  }

  /**
   * Emit a trigger event to the renderer
   */
  private emitTrigger(reason: 'idle' | 'repeated-clicks' | 'manual'): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    console.log('[SmartTrigger] Triggering help suggestion:', reason);

    this.mainWindow.webContents.send('smart-trigger:triggered', {
      reason,
      timestamp: Date.now(),
    });

    // Also show the window if it's hidden
    if (!this.mainWindow.isVisible()) {
      this.mainWindow.show();
    }
  }

  /**
   * Reset the current session
   */
  private resetSession(): void {
    this.state = this.createInitialState();
  }

  /**
   * Cleanup when service is disposed
   */
  dispose(): void {
    this.stopMonitoring();
    this.mainWindow = null;
  }
}

// Singleton instance
let smartTriggerInstance: SmartTriggerService | null = null;

/**
 * Get or create the smart trigger service instance
 */
export function getSmartTrigger(): SmartTriggerService {
  if (!smartTriggerInstance) {
    smartTriggerInstance = new SmartTriggerService();
  }
  return smartTriggerInstance;
}

/**
 * Initialize the smart trigger service with the main window
 */
export function initializeSmartTrigger(window: BrowserWindow): void {
  const service = getSmartTrigger();
  service.initialize(window);
}

/**
 * Dispose the smart trigger service
 */
export function disposeSmartTrigger(): void {
  if (smartTriggerInstance) {
    smartTriggerInstance.dispose();
    smartTriggerInstance = null;
  }
}
