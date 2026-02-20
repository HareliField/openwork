/**
 * Desktop context types for window enumeration, accessibility inspection, and screenshot capture
 */

/**
 * Represents a window on the desktop
 */
export interface DesktopWindow {
  /** Unique window ID (CGWindowID on macOS) */
  id: number;
  /** Application name (e.g., "Safari", "Code") */
  appName: string;
  /** Process ID */
  pid: number;
  /** Window title */
  title: string;
  /** Window bounds */
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Z-order (higher = more front) */
  zOrder: number;
  /** Whether window is currently on screen */
  isOnScreen: boolean;
  /** Whether window is minimized */
  isMinimized: boolean;
  /** Whether window is visible (not hidden) */
  isVisible: boolean;
  /** Layer (normal, desktop, etc.) */
  layer: number;
}

/**
 * Represents a node in the accessibility tree
 */
export interface AccessibleNode {
  /** Accessibility role (button, text, window, etc.) */
  role: string;
  /** Title/label of the element */
  title?: string;
  /** Value of the element (e.g., text field content) */
  value?: string;
  /** Description/help text */
  description?: string;
  /** Element bounds */
  frame?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Child nodes */
  children?: AccessibleNode[];
  /** Available actions (click, press, etc.) */
  actions?: string[];
  /** Whether element is enabled */
  enabled?: boolean;
  /** Whether element is focused */
  focused?: boolean;
  /** Parent window ID */
  windowId?: number;
  /** Application PID */
  appId?: number;
}

/**
 * Represents a screenshot capture
 */
export interface DesktopScreenshot {
  /** Unique screenshot ID */
  id: string;
  /** Timestamp when captured */
  timestamp: string;
  /** Region captured */
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** File path to the screenshot image */
  imagePath: string;
  /** Window ID if this is a window screenshot */
  windowId?: number;
}

/**
 * Complete desktop context snapshot
 */
export interface DesktopContextSnapshot {
  /** Timestamp when snapshot was taken */
  timestamp: string;
  /** All windows */
  windows: DesktopWindow[];
  /** Accessibility trees for inspected windows (keyed by window ID) */
  accessibilityTrees?: Record<number, AccessibleNode>;
  /** Screenshots if captured */
  screenshots?: DesktopScreenshot[];
}

/**
 * Options for capturing desktop context
 */
export interface DesktopContextOptions {
  /** Whether to include window metadata */
  includeWindows?: boolean;
  /** Window IDs to inspect via accessibility API */
  inspectWindowIds?: number[];
  /** Whether to capture screenshots */
  captureScreenshots?: boolean;
  /** Screenshot mode: 'screen' (full screen), 'window' (specific window), 'region' (custom rect) */
  screenshotMode?: 'screen' | 'window' | 'region';
  /** Window ID for window screenshot mode */
  screenshotWindowId?: number;
  /** Custom region for screenshot */
  screenshotRegion?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Maximum depth for accessibility tree traversal */
  maxAccessibilityDepth?: number;
  /** Maximum number of nodes in accessibility tree */
  maxAccessibilityNodes?: number;
}
