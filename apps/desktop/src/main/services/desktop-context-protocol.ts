/**
 * Protocol definitions for communication between Electron main process
 * and the macOS native helper for desktop context operations
 */

/**
 * Command sent to the native helper
 */
export interface DesktopContextCommand {
  /** Command type */
  cmd: 'list_windows' | 'inspect_window' | 'capture';
  /** Request ID for matching responses */
  id: string;
  /** Command-specific parameters */
  params?: {
    /** Window ID for inspect_window or capture */
    windowId?: number;
    /** Capture mode: 'screen', 'window', or 'region' */
    mode?: 'screen' | 'window' | 'region';
    /** Region bounds for 'region' mode */
    rect?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    /** Maximum depth for accessibility tree */
    maxDepth?: number;
    /** Maximum nodes in accessibility tree */
    maxNodes?: number;
  };
}

/**
 * Response from the native helper
 */
export interface DesktopContextResponse {
  /** Request ID matching the command */
  id: string;
  /** Whether the command succeeded */
  success: boolean;
  /** Error message if success is false */
  error?: string;
  /** Response data */
  data?: {
    /** Windows list (for list_windows) */
    windows?: Array<{
      id: number;
      appName: string;
      pid: number;
      title: string;
      bounds: { x: number; y: number; width: number; height: number };
      zOrder: number;
      isOnScreen: boolean;
      isMinimized: boolean;
      isVisible: boolean;
      layer: number;
    }>;
    /** Accessibility tree (for inspect_window) */
    tree?: {
      role: string;
      title?: string;
      value?: string;
      description?: string;
      frame?: { x: number; y: number; width: number; height: number };
      children?: unknown[];
      actions?: string[];
      enabled?: boolean;
      focused?: boolean;
      windowId?: number;
      appId?: number;
    };
    /** Screenshot path (for capture) */
    imagePath?: string;
    /** Screenshot region */
    region?: { x: number; y: number; width: number; height: number };
  };
}

/**
 * Error codes that may be returned
 */
export enum DesktopContextErrorCode {
  PERMISSION_DENIED = 'permission_denied',
  WINDOW_NOT_FOUND = 'window_not_found',
  ACCESSIBILITY_DISABLED = 'accessibility_disabled',
  SCREEN_RECORDING_DENIED = 'screen_recording_denied',
  INVALID_PARAMS = 'invalid_params',
  HELPER_CRASHED = 'helper_crashed',
  TIMEOUT = 'timeout',
}
