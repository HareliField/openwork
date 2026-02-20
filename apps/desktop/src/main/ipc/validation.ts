import { z } from 'zod';

export const taskConfigSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  taskId: z.string().optional(),
  workingDirectory: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  systemPromptAppend: z.string().optional(),
  outputSchema: z.record(z.any()).optional(),
  sessionId: z.string().optional(),
  chrome: z.boolean().optional(),
});

export const permissionResponseSchema = z.object({
  requestId: z.string().min(1, 'Request ID is required'),
  taskId: z.string().min(1, 'Task ID is required'),
  decision: z.enum(['allow', 'deny']),
  message: z.string().optional(),
  selectedOptions: z.array(z.string()).optional(),
});

export const resumeSessionSchema = z.object({
  sessionId: z.string().min(1, 'Session ID is required'),
  prompt: z.string().min(1, 'Prompt is required'),
  existingTaskId: z.string().optional(),
  chrome: z.boolean().optional(),
});

// API error response schema
export const apiErrorResponseSchema = z.object({
  error: z.object({
    message: z.string().optional(),
  }).optional(),
}).passthrough();

// Ollama tags response schema
export const ollamaTagsResponseSchema = z.object({
  models: z.array(z.object({
    name: z.string(),
    size: z.number(),
  })).optional().default([]),
}).passthrough();

const desktopControlOverallStatusSchema = z.enum([
  'ready',
  'needs_screen_recording_permission',
  'needs_accessibility_permission',
  'mcp_unhealthy',
  'unknown',
]);

const desktopControlCapabilitySchema = z.enum([
  'screen_capture',
  'action_execution',
  'mcp_health',
]);

const desktopControlCheckStatusSchema = z.enum([
  'ready',
  'blocked',
  'unknown',
]);

const desktopControlRemediationSchema = z.object({
  title: z.string().min(1, 'Remediation title is required'),
  steps: z.array(z.string().min(1)).min(1, 'At least one remediation step is required'),
  systemSettingsPath: z.string().optional(),
});

const desktopControlCapabilityStatusSchema = z.object({
  capability: desktopControlCapabilitySchema,
  status: desktopControlCheckStatusSchema,
  errorCode: z.string().nullable(),
  message: z.string().min(1, 'Capability message is required'),
  remediation: desktopControlRemediationSchema,
  checkedAt: z.string().datetime(),
  details: z.record(z.any()).optional(),
});

export const desktopControlStatusResponseSchema = z.object({
  status: desktopControlOverallStatusSchema,
  errorCode: z.string().nullable(),
  message: z.string().min(1, 'Status message is required'),
  remediation: desktopControlRemediationSchema,
  checkedAt: z.string().datetime(),
  cache: z.object({
    ttlMs: z.number().int().positive(),
    expiresAt: z.string().datetime(),
    fromCache: z.boolean(),
  }),
  checks: z.object({
    screen_capture: desktopControlCapabilityStatusSchema,
    action_execution: desktopControlCapabilityStatusSchema,
    mcp_health: desktopControlCapabilityStatusSchema,
  }),
});

export const desktopControlStatusRequestSchema = z.object({
  forceRefresh: z.boolean().optional(),
});

export function validate<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  payload: unknown
): z.infer<TSchema> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const message = result.error.issues.map((issue: z.ZodIssue) => issue.message).join('; ');
    throw new Error(`Invalid payload: ${message}`);
  }
  return result.data;
}

export function normalizeIpcError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === 'string' ? error : 'Unknown IPC error');
}
