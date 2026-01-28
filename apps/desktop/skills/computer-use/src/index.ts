#!/usr/bin/env node
/**
 * Computer Use MCP Server
 *
 * Exposes tools for computer interaction:
 * - screenshot: Capture the entire screen
 * - screenshot_window: Capture a specific window
 * - list_windows: List available windows
 *
 * Communicates with the Electron main process via HTTP to access
 * the desktopCapturer API.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

const SCREENSHOT_API_PORT = process.env.SCREENSHOT_API_PORT || '9227';
const SCREENSHOT_API_BASE = `http://localhost:${SCREENSHOT_API_PORT}`;

interface ScreenshotWindowInput {
  windowTitle: string;
}

const server = new Server(
  { name: 'computer-use', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'screenshot',
      description:
        'Capture a screenshot of the entire screen. Returns a base64-encoded PNG image. Use this to see what is currently displayed on the computer screen.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'screenshot_window',
      description:
        'Capture a screenshot of a specific window by its title (partial match, case-insensitive). Returns a base64-encoded PNG image. Use list_windows first to see available windows.',
      inputSchema: {
        type: 'object',
        properties: {
          windowTitle: {
            type: 'string',
            description: 'The title (or partial title) of the window to capture',
          },
        },
        required: ['windowTitle'],
      },
    },
    {
      name: 'list_windows',
      description:
        'List all available windows that can be captured. Returns window names and IDs. Use this before screenshot_window to find the correct window title.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const toolName = request.params.name;

  try {
    switch (toolName) {
      case 'screenshot': {
        const response = await fetch(`${SCREENSHOT_API_BASE}/screenshot`, {
          method: 'GET',
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [
              { type: 'text', text: `Error: Screenshot API returned ${response.status}: ${errorText}` },
            ],
            isError: true,
          };
        }

        const result = (await response.json()) as { image: string; format: string };

        // Return as image content for vision models
        return {
          content: [
            {
              type: 'image',
              data: result.image,
              mimeType: 'image/png',
            },
          ],
        };
      }

      case 'screenshot_window': {
        const args = request.params.arguments as unknown as ScreenshotWindowInput;
        const { windowTitle } = args;

        if (!windowTitle) {
          return {
            content: [{ type: 'text', text: 'Error: windowTitle is required' }],
            isError: true,
          };
        }

        const response = await fetch(`${SCREENSHOT_API_BASE}/screenshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ windowTitle }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [
              { type: 'text', text: `Error: Screenshot API returned ${response.status}: ${errorText}` },
            ],
            isError: true,
          };
        }

        const result = (await response.json()) as { image: string; format: string };

        // Return as image content for vision models
        return {
          content: [
            {
              type: 'image',
              data: result.image,
              mimeType: 'image/png',
            },
          ],
        };
      }

      case 'list_windows': {
        const response = await fetch(`${SCREENSHOT_API_BASE}/windows`, {
          method: 'GET',
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            content: [
              { type: 'text', text: `Error: Screenshot API returned ${response.status}: ${errorText}` },
            ],
            isError: true,
          };
        }

        const result = (await response.json()) as { windows: Array<{ name: string; id: string }> };

        // Format windows list for display
        if (result.windows.length === 0) {
          return {
            content: [{ type: 'text', text: 'No windows available' }],
          };
        }

        const windowsList = result.windows
          .map((w, i) => `${i + 1}. ${w.name}`)
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: `Available windows:\n${windowsList}`,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Error: Unknown tool: ${toolName}` }],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if it's a connection error (API not running)
    if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed')) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Screenshot API is not running. The Openwork desktop app must be running to capture screenshots.`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start the MCP server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Computer Use MCP Server started');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
