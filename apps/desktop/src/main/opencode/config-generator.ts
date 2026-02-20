import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { PERMISSION_API_PORT } from '../permission-api';
import { getOllamaConfig, getSelectedModel } from '../store/appSettings';
import { getNpxPath, getBundledNodePaths } from '../utils/bundled-node';

/**
 * Agent name used by Screen Agent
 */
export const ACCOMPLISH_AGENT_NAME = 'screen-agent';

/**
 * Get the skills directory path
 * In dev: apps/desktop/skills
 * In packaged: resources/skills (unpacked from asar)
 */
export function getSkillsPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'skills');
  } else {
    return path.join(app.getAppPath(), 'skills');
  }
}

/**
 * System prompt for the Screen Agent.
 * The agent can see the user's screen and help guide them through tasks.
 */
const SCREEN_AGENT_SYSTEM_PROMPT = `<identity>
You are a helpful Screen Agent - like a teacher sitting next to the user, able to see their screen and guide them through any task on their Mac.
</identity>

<environment>
This app bundles Node.js. The bundled path is available in the NODE_BIN_PATH environment variable.
Before running node/npx/npm commands, prepend it to PATH:

PATH="\${NODE_BIN_PATH}:\$PATH" npx tsx ...

Never assume Node.js is installed system-wide. Always use the bundled version.
</environment>

<capabilities>
You can:
- **See the user's screen** via the capture_screen tool
- **Get active window info** via get_screen_info tool
- **Run live screen sessions** via start_live_view, get_live_frame, stop_live_view tools
- **Perform mouse actions** via click, move_mouse, double_click tools
- **Perform keyboard actions** via type_text, press_key tools
- **Help the user navigate** any application on their Mac
</capabilities>

<important name="filesystem-rules">
##############################################################################
# CRITICAL: FILE PERMISSION WORKFLOW - NEVER SKIP
##############################################################################

BEFORE using Write, Edit, Bash (with file ops), or ANY tool that touches files:
1. FIRST: Call request_file_permission tool and wait for response
2. ONLY IF response is "allowed": Proceed with the file operation
3. IF "denied": Stop and inform the user

This applies to ALL file operations:
- Creating files (Write tool, bash echo/cat, scripts that output files)
- Renaming files (bash mv, rename commands)
- Deleting files (bash rm, delete commands)
- Modifying files (Edit tool, bash sed/awk, any content changes)

VIOLATION = CRITICAL FAILURE. No exceptions. Ever.
##############################################################################
</important>

<tool name="request_file_permission">
Use this MCP tool to request user permission before performing file operations.

Input:
{
  "operation": "create" | "delete" | "rename" | "move" | "modify" | "overwrite",
  "filePath": "/absolute/path/to/file",
  "targetPath": "/new/path",       // Required for rename/move
  "contentPreview": "file content" // Optional preview for create/modify/overwrite
}

Returns: "allowed" or "denied" - proceed only if allowed
</tool>

<workflow>
When the user asks for help:

1. Decide if the request needs current screen context.
2. If the request is about what's visible now, **take a screenshot** using capture_screen.
3. If the request is general chat, coding, or planning, answer directly without screen tools.
4. When using a screenshot, analyze UI elements and give clear guidance:
   - "Click the blue 'Save' button in the top-right corner"
   - "Look for the gear icon in the menu bar, about 3 inches from the right edge"
   - "The setting you need is in System Settings > Privacy & Security > Accessibility"

If the user asks you to perform an action:
1. First describe what you'll do
2. Ask for confirmation if it's a significant action
3. Perform the action using click, type_text, or press_key tools
4. Take another screenshot to confirm success
</workflow>

<live-view-workflow>
Use live view when the UI is changing quickly or when you need repeated visual checks.
1. Start a session with start_live_view
2. Poll for updates with get_live_frame after each meaningful step (or while waiting for UI changes)
3. Stop the session with stop_live_view when done, when switching tasks, or when the user pauses
</live-view-workflow>

<guidance-style>
- Be concise and specific
- Describe locations clearly (top-left, center, bottom-right, etc.)
- Reference visual landmarks ("next to the red X button", "below the search bar")
- If you can't find something, say so and suggest alternatives
- For complex tasks, break them into small steps
</guidance-style>

<hybrid-mode>
The user can choose:
- **Guide mode**: You tell them what to click, they do it themselves
- **Action mode**: You perform the clicks and typing for them

Default to guide mode unless the user asks you to "do it" or "perform the action".
Always confirm before performing destructive actions (delete, overwrite, etc.).
</hybrid-mode>

<smart-trigger>
When triggered by the smart-trigger system (idle detection), you will receive a prompt to capture the screen automatically.
IMPORTANT: Do NOT respond with generic offers like "Would you like me to help?" or "I noticed you might need help."
Instead:
1. Immediately capture the screen using capture_screen
2. Analyze what the user is doing RIGHT NOW
3. Give a brief, specific, actionable observation or suggestion
4. Keep it to 1-2 sentences max

Examples of GOOD responses:
- "You have a TypeScript error on line 42 - looks like a missing import for useState."
- "I see you're on the GitHub PR page. The failing check is a lint error in src/utils.ts."
- "Your terminal shows a build error: missing dependency 'react-router'. Try running npm install."

Examples of BAD responses (NEVER do these):
- "I noticed you might need some help. Would you like me to look at your screen?"
- "It looks like you're working on something. How can I assist you?"
- "I see you're busy. Let me know if you need anything."
</smart-trigger>

<blocked-tool-recovery>
If a required tool fails, is blocked, or is unavailable:
1. Name blocker once in one sentence (tool + concrete failure reason)
2. Provide one exact fix path once (specific menu path, command, or file path)
3. Ask one concrete follow-up question that unblocks the next action
4. Do not repeat generic fallback text on later turns; reference the prior blocker briefly and wait for the answer
</blocked-tool-recovery>

<behavior>
- Be concise. Short answers. No filler.
- Act first, explain after. Don't ask permission for non-destructive actions.
- If you can see the problem, state the solution immediately.
- Don't comment on personal content visible on screen.
- If something is unclear, ask one specific question.
</behavior>
`;

interface AgentConfig {
  description?: string;
  prompt?: string;
  mode?: 'primary' | 'subagent' | 'all';
}

interface McpServerConfig {
  type?: 'local' | 'remote';
  command?: string[];
  url?: string;
  enabled?: boolean;
  environment?: Record<string, string>;
  timeout?: number;
}

interface OllamaProviderModelConfig {
  name: string;
  tools?: boolean;
}

interface OpenAICompatibleProviderConfig {
  npm?: string;
  name: string;
  options?: {
    baseURL?: string;
    apiKey?: string;
  };
  models: Record<string, OllamaProviderModelConfig>;
}

interface OpenCodeConfig {
  $schema?: string;
  model?: string;
  default_agent?: string;
  enabled_providers?: string[];
  permission?: string | Record<string, string | Record<string, string>>;
  agent?: Record<string, AgentConfig>;
  mcp?: Record<string, McpServerConfig>;
  provider?: Record<string, OpenAICompatibleProviderConfig>;
}

/**
 * Generate OpenCode configuration file
 */
export async function generateOpenCodeConfig(): Promise<string> {
  const configDir = path.join(app.getPath('userData'), 'opencode');
  const configPath = path.join(configDir, 'opencode.json');

  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Get skills directory path
  const skillsPath = getSkillsPath();

  console.log('[OpenCode Config] Skills path:', skillsPath);

  // Get npx path - use bundled npx in packaged app, system npx in dev
  const npxPath = getNpxPath();
  const bundledPaths = getBundledNodePaths();
  
  // Build environment for MCP servers with proper PATH.
  // Keep bundled Node.js first when available, then system paths, then inherited PATH.
  const pathDelimiter = process.platform === 'win32' ? ';' : ':';
  const basePathEntries = (process.env.PATH || '')
    .split(pathDelimiter)
    .filter(Boolean);
  const mcpPathEntries: string[] = [];
  const appendPathEntry = (entry?: string) => {
    if (!entry || mcpPathEntries.includes(entry)) {
      return;
    }
    mcpPathEntries.push(entry);
  };

  if (bundledPaths) {
    appendPathEntry(bundledPaths.binDir);
  }

  // Ensure POSIX system binary locations are available for shell commands
  // (screencapture, osascript, etc.) while avoiding invalid PATH entries on Windows.
  if (process.platform !== 'win32') {
    for (const entry of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
      appendPathEntry(entry);
    }
  }

  for (const entry of basePathEntries) {
    appendPathEntry(entry);
  }

  const mcpPath = mcpPathEntries.join(pathDelimiter);

  const shellPath = process.platform === 'win32'
    ? (process.env.COMSPEC || 'cmd.exe')
    : '/bin/sh';
  const mcpEnvironment: Record<string, string> = {
    PATH: mcpPath,
    // Ensure SHELL is set for any subprocess that needs it.
    SHELL: shellPath,
  };
  
  console.log('[OpenCode Config] Using npx path:', npxPath);

  // Build file-permission MCP server command
  const filePermissionServerPath = path.join(skillsPath, 'file-permission', 'src', 'index.ts');
  
  // Build screen-capture MCP server command
  const screenCaptureServerPath = path.join(skillsPath, 'screen-capture', 'src', 'index.ts');
  
  // Build action-executor MCP server command
  const actionExecutorServerPath = path.join(skillsPath, 'action-executor', 'src', 'index.ts');

  // Build live-screen-stream MCP server command
  const liveScreenStreamServerPath = path.join(skillsPath, 'live-screen-stream', 'src', 'index.ts');
  const selectedModel = getSelectedModel();

  // Enable providers - add OpenRouter and conditionally Ollama.
  const ollamaConfig = getOllamaConfig();
  const baseProviders = ['anthropic', 'openai', 'google', 'xai', 'openrouter'];
  const enabledProviders = ollamaConfig?.enabled
    ? [...baseProviders, 'ollama']
    : baseProviders;

  const openrouterModels: Record<string, OllamaProviderModelConfig> = {
    'openai/gpt-4o-mini': {
      name: 'GPT-4o mini (OpenRouter)',
      tools: true,
    },
    'moonshotai/kimi-k2': {
      name: 'Kimi K2 (OpenRouter)',
      tools: true,
    },
  };

  // Provider customization:
  // - OpenRouter: pin API key to OPENROUTER_API_KEY.
  // - Ollama: include local endpoint and discovered models when configured.
  const providerConfig: Record<string, OpenAICompatibleProviderConfig> = {
    openrouter: {
      npm: '@ai-sdk/openai-compatible',
      name: 'OpenRouter',
      options: {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: '{env:OPENROUTER_API_KEY}',
      },
      models: openrouterModels,
    },
  };

  if (ollamaConfig?.enabled && ollamaConfig.models && ollamaConfig.models.length > 0) {
    const ollamaModels: Record<string, OllamaProviderModelConfig> = {};
    for (const model of ollamaConfig.models) {
      ollamaModels[model.id] = {
        name: model.displayName,
        tools: true,
      };
    }

    providerConfig.ollama = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: {
        baseURL: `${ollamaConfig.baseUrl}/v1`,
      },
      models: ollamaModels,
    };

    console.log('[OpenCode Config] Ollama provider configured with models:', Object.keys(ollamaModels));
  }

  const config: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    model: selectedModel?.model,
    default_agent: ACCOMPLISH_AGENT_NAME,
    enabled_providers: enabledProviders,
    // Auto-allow all tool permissions - the agent uses UI modals for user confirmations
    permission: 'allow',
    provider: providerConfig,
    agent: {
      [ACCOMPLISH_AGENT_NAME]: {
        description: 'Screen agent that can see your screen and guide you through tasks',
        prompt: SCREEN_AGENT_SYSTEM_PROMPT,
        mode: 'primary',
      },
    },
    // MCP servers for screen capture, live stream, actions, and file permissions
    // Use full npx path to avoid "command not found" in packaged apps
    mcp: {
      'file-permission': {
        type: 'local',
        command: [npxPath, 'tsx', filePermissionServerPath],
        enabled: true,
        environment: {
          ...mcpEnvironment,
          PERMISSION_API_PORT: String(PERMISSION_API_PORT),
        },
        timeout: 10000,
      },
      'screen-capture': {
        type: 'local',
        command: [npxPath, 'tsx', screenCaptureServerPath],
        enabled: true,
        environment: mcpEnvironment,
        timeout: 30000, // Screenshots can take a moment
      },
      'live-screen-stream': {
        type: 'local',
        command: [npxPath, 'tsx', liveScreenStreamServerPath],
        enabled: true,
        environment: mcpEnvironment,
        timeout: 30000, // Live frame sampling can take a moment
      },
      'action-executor': {
        type: 'local',
        command: [npxPath, 'tsx', actionExecutorServerPath],
        enabled: true,
        environment: mcpEnvironment,
        timeout: 10000,
      },
    },
  };

  // Write config file
  const configJson = JSON.stringify(config, null, 2);
  fs.writeFileSync(configPath, configJson);

  // Set environment variable for OpenCode to find the config
  process.env.OPENCODE_CONFIG = configPath;

  console.log('[OpenCode Config] Generated config at:', configPath);
  console.log('[OpenCode Config] OPENCODE_CONFIG env set to:', process.env.OPENCODE_CONFIG);

  return configPath;
}

/**
 * Get the path where OpenCode config is stored
 */
export function getOpenCodeConfigPath(): string {
  return path.join(app.getPath('userData'), 'opencode', 'opencode.json');
}
