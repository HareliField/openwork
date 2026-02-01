/**
 * Screen Capture Service
 *
 * Provides live screen capture functionality using Electron's desktopCapturer API.
 * This service manages screen source discovery and provides methods to get
 * available screens/windows for capture.
 */

import { desktopCapturer, screen } from 'electron';

export interface ScreenSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  displayId: string;
  appIconDataUrl?: string;
}

export interface CaptureOptions {
  types: ('screen' | 'window')[];
  thumbnailSize?: { width: number; height: number };
  fetchWindowIcons?: boolean;
}

/**
 * Get available screen sources for capture
 */
export async function getScreenSources(options?: CaptureOptions): Promise<ScreenSource[]> {
  const captureOptions = {
    types: options?.types || ['screen', 'window'],
    thumbnailSize: options?.thumbnailSize || { width: 320, height: 180 },
    fetchWindowIcons: options?.fetchWindowIcons ?? true,
  };

  try {
    const sources = await desktopCapturer.getSources({
      types: captureOptions.types,
      thumbnailSize: captureOptions.thumbnailSize,
      fetchWindowIcons: captureOptions.fetchWindowIcons,
    });

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.toDataURL(),
      displayId: source.display_id,
      appIconDataUrl: source.appIcon?.toDataURL(),
    }));
  } catch (error) {
    console.error('[ScreenCapture] Failed to get sources:', error);
    throw error;
  }
}

/**
 * Get the primary display information
 */
export function getPrimaryDisplay() {
  const primaryDisplay = screen.getPrimaryDisplay();
  return {
    id: primaryDisplay.id.toString(),
    bounds: primaryDisplay.bounds,
    scaleFactor: primaryDisplay.scaleFactor,
    size: primaryDisplay.size,
    workArea: primaryDisplay.workArea,
  };
}

/**
 * Get all displays information
 */
export function getAllDisplays() {
  return screen.getAllDisplays().map((display) => ({
    id: display.id.toString(),
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
    size: display.size,
    workArea: display.workArea,
    isPrimary: display.id === screen.getPrimaryDisplay().id,
  }));
}

/**
 * Get the desktop capturer source ID for a specific display
 * This is used by the renderer to request the stream via getUserMedia
 */
export async function getScreenSourceId(displayId?: string): Promise<string | null> {
  const sources = await getScreenSources({ types: ['screen'] });

  if (displayId) {
    const source = sources.find((s) => s.displayId === displayId);
    return source?.id || null;
  }

  // Return primary screen if no displayId specified
  return sources[0]?.id || null;
}
