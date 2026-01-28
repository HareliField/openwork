/**
 * Screenshot API Server
 *
 * HTTP server that the computer-use MCP server calls to capture screenshots.
 * This bridges the MCP server (separate process) with Electron's desktopCapturer API.
 */

import http from 'http';
import { desktopCapturer, screen } from 'electron';

export const SCREENSHOT_API_PORT = 9227;

/**
 * Capture a screenshot of the entire screen
 * Returns base64-encoded PNG data
 */
async function captureScreen(): Promise<string> {
  // Get the primary display dimensions
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const scaleFactor = primaryDisplay.scaleFactor;

  // Get all available sources (screens and windows)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * scaleFactor),
      height: Math.round(height * scaleFactor),
    },
  });

  if (sources.length === 0) {
    throw new Error('No screen sources available');
  }

  // Use the first screen (primary display)
  const primarySource = sources[0];
  const thumbnail = primarySource.thumbnail;

  if (thumbnail.isEmpty()) {
    throw new Error('Failed to capture screen - empty thumbnail');
  }

  // Convert to PNG and return as base64
  const pngBuffer = thumbnail.toPNG();
  return pngBuffer.toString('base64');
}

/**
 * Capture a screenshot of a specific window by title (partial match)
 */
async function captureWindow(windowTitle: string): Promise<string> {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const scaleFactor = primaryDisplay.scaleFactor;

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: {
      width: Math.round(width * scaleFactor),
      height: Math.round(height * scaleFactor),
    },
  });

  // Find window by partial title match (case-insensitive)
  const matchingSource = sources.find((source) =>
    source.name.toLowerCase().includes(windowTitle.toLowerCase())
  );

  if (!matchingSource) {
    const availableWindows = sources.map((s) => s.name).join(', ');
    throw new Error(
      `Window "${windowTitle}" not found. Available windows: ${availableWindows || 'none'}`
    );
  }

  const thumbnail = matchingSource.thumbnail;
  if (thumbnail.isEmpty()) {
    throw new Error(`Failed to capture window "${windowTitle}" - empty thumbnail`);
  }

  const pngBuffer = thumbnail.toPNG();
  return pngBuffer.toString('base64');
}

/**
 * List all available windows
 */
async function listWindows(): Promise<Array<{ name: string; id: string }>> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 150, height: 150 }, // Small thumbnails for listing
  });

  return sources.map((source) => ({
    name: source.name,
    id: source.id,
  }));
}

/**
 * Create and start the HTTP server for screenshot requests
 */
export function startScreenshotApiServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${SCREENSHOT_API_PORT}`);

    try {
      // GET /screenshot - capture full screen
      if (req.method === 'GET' && url.pathname === '/screenshot') {
        console.log('[Screenshot API] Capturing full screen...');
        const base64 = await captureScreen();
        console.log('[Screenshot API] Screen captured successfully');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ image: base64, format: 'png' }));
        return;
      }

      // POST /screenshot - capture with options
      if (req.method === 'POST' && url.pathname === '/screenshot') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }

        let options: { windowTitle?: string } = {};
        if (body) {
          try {
            options = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }
        }

        let base64: string;
        if (options.windowTitle) {
          console.log(`[Screenshot API] Capturing window: ${options.windowTitle}`);
          base64 = await captureWindow(options.windowTitle);
        } else {
          console.log('[Screenshot API] Capturing full screen...');
          base64 = await captureScreen();
        }

        console.log('[Screenshot API] Screenshot captured successfully');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ image: base64, format: 'png' }));
        return;
      }

      // GET /windows - list available windows
      if (req.method === 'GET' && url.pathname === '/windows') {
        console.log('[Screenshot API] Listing windows...');
        const windows = await listWindows();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ windows }));
        return;
      }

      // GET /health - health check
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Screenshot API] Error:', errorMessage);

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errorMessage }));
    }
  });

  server.listen(SCREENSHOT_API_PORT, '127.0.0.1', () => {
    console.log(`[Screenshot API] Server listening on port ${SCREENSHOT_API_PORT}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(
        `[Screenshot API] Port ${SCREENSHOT_API_PORT} already in use, skipping server start`
      );
    } else {
      console.error('[Screenshot API] Server error:', error);
    }
  });

  return server;
}
