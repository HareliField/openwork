'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Send,
  Camera,
  Settings,
  Minimize2,
  Loader2,
  Bot,
  Image as ImageIcon,
  History,
  Plus,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { cn } from '../lib/utils';
import {
  getAccomplish,
  getDesktopControlStatus,
  type DesktopControlCapability,
  type DesktopControlStatusPayload,
} from '../lib/accomplish';
import type { Task, TaskMessage } from '@accomplish/shared';
import ReactMarkdown from 'react-markdown';
import { DiagnosticsPanel } from './desktop-control/DiagnosticsPanel';
import {
  buildDesktopControlBlockedMessage,
  createDesktopControlBlockerKey,
  getDesktopControlBlockedCapabilities,
  shouldEmitDesktopControlFallback,
  type DesktopControlRequirement,
} from './desktop-control/fallbackGuard';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: Date;
  attachments?: Array<{ type: 'screenshot'; data: string }>;
}

interface FloatingChatProps {
  onOpenSettings?: () => void;
}

const SCREEN_CAPTURE_REQUIREMENT: DesktopControlRequirement = {
  blockedAction: 'screenshots',
  capabilities: ['screen_capture', 'mcp_health'],
};

const LIVE_VIEW_HINTS = /\b(live\s*(view|stream)|livestream|real[-\s]?time|watch\s+my\s+screen|monitor\s+my\s+screen|film(?:ing)?\s+my\s+(screen|computer)|record(?:ing)?\s+my\s+(screen|computer))\b/i;
const SCREEN_CAPTURE_HINTS = /\b(screenshot|screen\s?shot|capture\s+(?:my\s+)?screen|what(?:'| i)?s on my screen|look at my screen|see my screen)\b/i;
const ACTION_EXECUTION_HINTS = /\b(click|double[-\s]?click|move\s+(?:my\s+|the\s+)?mouse|drag|drop|scroll|press\s+(?:the\s+)?(?:key|button)|type(?:\s+text)?|keyboard|mouse\s+(?:to|over|onto)|shortcut)\b/i;

function inferDesktopControlRequirement(prompt: string): DesktopControlRequirement | null {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) return null;

  const needsLiveView = LIVE_VIEW_HINTS.test(normalizedPrompt);
  const needsActionExecution = ACTION_EXECUTION_HINTS.test(normalizedPrompt);
  const needsScreenCapture = needsLiveView || SCREEN_CAPTURE_HINTS.test(normalizedPrompt);

  if (!needsActionExecution && !needsScreenCapture) {
    return null;
  }

  const capabilities = new Set<DesktopControlCapability>(['mcp_health']);
  if (needsScreenCapture) {
    capabilities.add('screen_capture');
  }
  if (needsActionExecution) {
    capabilities.add('action_execution');
  }

  let blockedAction = 'desktop control actions';
  if (needsLiveView) {
    blockedAction = 'live screen capture';
  } else if (needsScreenCapture && needsActionExecution) {
    blockedAction = 'desktop actions and screenshots';
  } else if (needsActionExecution) {
    blockedAction = 'desktop actions';
  } else if (needsScreenCapture) {
    blockedAction = 'screenshots';
  }

  return {
    blockedAction,
    capabilities: Array.from(capabilities),
  };
}

function mergeConsecutiveAssistantMessages(source: Message[]): Message[] {
  const merged: Message[] = [];

  for (const message of source) {
    const last = merged[merged.length - 1];

    if (message.role === 'assistant' && last?.role === 'assistant') {
      const combinedAttachments = [
        ...(last.attachments ?? []),
        ...(message.attachments ?? []),
      ];

      if (last.content.trim() === message.content.trim()) {
        merged[merged.length - 1] = {
          ...last,
          timestamp: message.timestamp,
          attachments: combinedAttachments.length > 0 ? combinedAttachments : undefined,
        };
      } else {
        merged[merged.length - 1] = {
          ...last,
          id: `${last.id}__merged_with__${message.id}`,
          content: `${last.content}\n\n${message.content}`,
          timestamp: message.timestamp,
          attachments: combinedAttachments.length > 0 ? combinedAttachments : undefined,
        };
      }

      continue;
    }

    merged.push(message);
  }

  return merged;
}

export function FloatingChat({ onOpenSettings }: FloatingChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [taskHistory, setTaskHistory] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [desktopControlStatus, setDesktopControlStatus] = useState<DesktopControlStatusPayload | null>(null);
  const [desktopControlError, setDesktopControlError] = useState<string | null>(null);
  const [isCheckingDesktopControl, setIsCheckingDesktopControl] = useState(false);
  const [showDiagnosticsPanel, setShowDiagnosticsPanel] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isCancellingRef = useRef(false);
  const lastDesktopControlBlockerKeyRef = useRef<string | null>(null);
  const isLoadingRef = useRef(isLoading);
  const currentTaskIdRef = useRef<string | null>(currentTaskId);
  const sessionIdRef = useRef<string | null>(sessionId);
  const selectedTaskIdRef = useRef<string | null>(selectedTaskId);
  const accomplish = getAccomplish();
  const displayMessages = useMemo(() => mergeConsecutiveAssistantMessages(messages), [messages]);

  const refreshTaskHistory = useCallback(async () => {
    try {
      const tasks = await accomplish.listTasks();
      setTaskHistory(tasks);
    } catch (error) {
      console.error('[FloatingChat] Failed to refresh task history:', error);
    }
  }, [accomplish]);

  const addAssistantMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `assistant-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        role: 'assistant',
        content,
        timestamp: new Date(),
      },
    ]);
  }, []);

  const checkDesktopControl = useCallback(async (
    options: { revealIfBlocked?: boolean; forceRefresh?: boolean } = {}
  ): Promise<DesktopControlStatusPayload | null> => {
    const { revealIfBlocked = false, forceRefresh = false } = options;

    setIsCheckingDesktopControl(true);
    setDesktopControlError(null);

    try {
      const status = await getDesktopControlStatus({ forceRefresh });
      setDesktopControlStatus(status);

      if (status.status === 'ready') {
        setShowDiagnosticsPanel(false);
      } else if (revealIfBlocked) {
        setShowDiagnosticsPanel(true);
      }

      return status;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Desktop control readiness check failed.';
      setDesktopControlError(message);
      if (revealIfBlocked) {
        setShowDiagnosticsPanel(true);
      }
      return null;
    } finally {
      setIsCheckingDesktopControl(false);
    }
  }, []);

  const ensureDesktopControlReady = useCallback(async (
    requirement: DesktopControlRequirement
  ): Promise<boolean> => {
    const status = await checkDesktopControl({
      revealIfBlocked: true,
      forceRefresh: true,
    });

    if (!status) {
      const blockerKey = `desktop-control-unverified:${requirement.blockedAction}`;
      if (
        shouldEmitDesktopControlFallback(lastDesktopControlBlockerKeyRef.current, blockerKey)
      ) {
        addAssistantMessage(
          'I could not verify desktop-control readiness. Open Diagnostics and press Recheck.'
        );
      }
      lastDesktopControlBlockerKeyRef.current = blockerKey;
      return false;
    }

    const blockedCapabilities = getDesktopControlBlockedCapabilities(status, requirement);
    if (blockedCapabilities.length > 0) {
      const blockerKey = createDesktopControlBlockerKey(status, requirement);
      if (shouldEmitDesktopControlFallback(lastDesktopControlBlockerKeyRef.current, blockerKey)) {
        addAssistantMessage(buildDesktopControlBlockedMessage(status, requirement));
      }
      lastDesktopControlBlockerKeyRef.current = blockerKey;
      return false;
    }

    lastDesktopControlBlockerKeyRef.current = null;
    return true;
  }, [addAssistantMessage, checkDesktopControl]);

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    currentTaskIdRef.current = currentTaskId;
  }, [currentTaskId]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const target = messagesEndRef.current;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth' });
    }
  }, [displayMessages, isLoading]);

  // Initial desktop-control readiness check on mount
  useEffect(() => {
    void checkDesktopControl({ revealIfBlocked: true });
  }, [checkDesktopControl]);

  // Load conversation history on mount
  useEffect(() => {
    const hydrateFromTask = (task: Task) => {
      if (!task.messages || task.messages.length === 0) return;

      const loadedMessages: Message[] = task.messages.map((msg) => ({
        id: msg.id,
        role: msg.type as 'user' | 'assistant' | 'tool',
        content: msg.content,
        timestamp: new Date(msg.timestamp),
        attachments: msg.attachments
          ?.filter((a) => a.type === 'screenshot')
          .map((a) => ({
            type: 'screenshot' as const,
            data: a.data,
          })),
      }));

      setMessages(loadedMessages);
      setCurrentTaskId(task.id);
      setSelectedTaskId(task.id);

      const session = task.sessionId || task.result?.sessionId || null;
      if (session) {
        sessionIdRef.current = session;
        setSessionId(session);
      }
    };

    const loadHistory = async () => {
      try {
        const tasks = await accomplish.listTasks();
        setTaskHistory(tasks);

        if (tasks.length > 0) {
          const latestTask = tasks[tasks.length - 1];
          hydrateFromTask(latestTask);
        }
      } catch (error) {
        console.error('[FloatingChat] Failed to load conversation history:', error);
      }
    };

    void loadHistory();
  }, [accomplish]);

  // Subscribe to smart trigger events - auto-capture screen and provide help
  useEffect(() => {
    const unsubscribeSmartTrigger = accomplish.onSmartTrigger?.(async (data) => {
      console.log('[FloatingChat] Smart trigger activated:', data.reason);

      // Skip if already loading (agent is already working)
      if (isLoadingRef.current) return;

      // Instead of asking a generic question, automatically take a screenshot
      // and analyze what the user might need help with
      const autoPrompt = "Take a screenshot of my screen right now and briefly tell me what you see. If it looks like I might be stuck or need help with something, give me a quick, actionable suggestion. Be concise.";

      try {
        const desktopControlReady = await ensureDesktopControlReady(SCREEN_CAPTURE_REQUIREMENT);
        if (!desktopControlReady) {
          return;
        }

        isLoadingRef.current = true;
        setIsLoading(true);

        const hasKey = await accomplish.hasAnyApiKey();
        if (!hasKey) {
          // No API key - show a simple message instead
          setMessages(prev => [...prev, {
            id: `trigger-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            role: 'assistant',
            content: "Need help? Add your API key in Settings to get started.",
            timestamp: new Date(),
          }]);
          isLoadingRef.current = false;
          setIsLoading(false);
          return;
        }

        // Cancel any existing task
        const taskIdToCancel = currentTaskIdRef.current;
        if (taskIdToCancel) {
          try {
            await accomplish.cancelTask(taskIdToCancel);
          } catch {
            // Ignore
          }
        }

        // Auto-start a task that captures and analyzes the screen
        const activeSessionId = sessionIdRef.current;
        if (activeSessionId) {
          await accomplish.resumeSession(activeSessionId, autoPrompt);
        } else {
          const nextTaskId = `trigger_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          currentTaskIdRef.current = nextTaskId;
          const task = await accomplish.startTask({
            prompt: autoPrompt,
            taskId: nextTaskId,
          });
          currentTaskIdRef.current = task.id;
          setCurrentTaskId(task.id);
        }
      } catch (error) {
        isLoadingRef.current = false;
        setIsLoading(false);
        console.error('[FloatingChat] Smart trigger auto-capture failed:', error);
      }
    });

    return () => {
      unsubscribeSmartTrigger?.();
    };
  }, [accomplish, ensureDesktopControlReady]);

  // Notify activity on user interaction
  useEffect(() => {
    const handleActivity = () => {
      accomplish.notifyActivity?.();
    };

    // Track mouse and keyboard activity
    window.addEventListener('mousemove', handleActivity, { passive: true });
    window.addEventListener('keydown', handleActivity, { passive: true });
    window.addEventListener('click', handleActivity, { passive: true });

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('click', handleActivity);
    };
  }, [accomplish]);

  // Subscribe to task events
  useEffect(() => {
    const unsubscribeTask = accomplish.onTaskUpdate((event) => {
      const activeTaskId = currentTaskIdRef.current ?? selectedTaskIdRef.current;
      if (!activeTaskId || event.taskId !== activeTaskId) {
        return;
      }

      if (event.type === 'message' && event.message) {
        const msg = event.message as TaskMessage;
        
        // Convert to our message format
        if (msg.type === 'assistant' && msg.content) {
          setMessages(prev => [...prev, {
            id: msg.id,
            role: 'assistant',
            content: msg.content,
            timestamp: new Date(msg.timestamp),
            attachments: msg.attachments?.filter(a => a.type === 'screenshot').map(a => ({
              type: 'screenshot' as const,
              data: a.data,
            })),
          }]);
        } else if (msg.type === 'tool' && msg.attachments?.length) {
          // Tool messages with screenshots
          const screenshots = msg.attachments.filter(a => a.type === 'screenshot');
          if (screenshots.length > 0) {
            setMessages(prev => [...prev, {
              id: msg.id,
              role: 'tool',
              content: msg.content || 'Screenshot captured',
              timestamp: new Date(msg.timestamp),
              attachments: screenshots.map(a => ({
                type: 'screenshot' as const,
                data: a.data,
              })),
            }]);
          }
        }
      }
      
      if (event.type === 'complete') {
        // Ignore completion events from tasks being cancelled (a new task is starting)
        if (isCancellingRef.current) return;
        isLoadingRef.current = false;
        setIsLoading(false);
        void refreshTaskHistory();
        if (event.result?.sessionId) {
          sessionIdRef.current = event.result.sessionId;
          setSessionId(event.result.sessionId);
        }
      }

      if (event.type === 'error') {
        // Ignore error events from tasks being cancelled
        if (isCancellingRef.current) return;
        isLoadingRef.current = false;
        setIsLoading(false);
        void refreshTaskHistory();
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          role: 'assistant',
          content: `Error: ${event.error || 'Something went wrong'}`,
          timestamp: new Date(),
        }]);
      }
    });

    // Handle batched updates
    const unsubscribeBatch = accomplish.onTaskUpdateBatch?.((event) => {
      const activeTaskId = currentTaskIdRef.current ?? selectedTaskIdRef.current;
      if (!activeTaskId || event.taskId !== activeTaskId) {
        return;
      }

      if (event.messages?.length) {
        const newMessages: Message[] = [];
        
        for (const msg of event.messages) {
          if (msg.type === 'assistant' && msg.content) {
            newMessages.push({
              id: msg.id,
              role: 'assistant',
              content: msg.content,
              timestamp: new Date(msg.timestamp),
              attachments: msg.attachments?.filter(a => a.type === 'screenshot').map(a => ({
                type: 'screenshot' as const,
                data: a.data,
              })),
            });
          }
        }
        
        if (newMessages.length > 0) {
          setMessages(prev => [...prev, ...newMessages]);
        }
      }
    });

    return () => {
      unsubscribeTask();
      unsubscribeBatch?.();
    };
  }, [accomplish, refreshTaskHistory]);

  // Send message
  const sendMessage = useCallback(async () => {
    if (!input.trim() || isLoading) return;
    setShowHistoryPanel(false);

    const prompt = input.trim();
    const userMessage: Message = {
      id: `user-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      role: 'user',
      content: prompt,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      // Check if we have an API key
      const hasKey = await accomplish.hasAnyApiKey();
      if (!hasKey) {
        setIsLoading(false);
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          role: 'assistant',
          content: 'Please add your API key in Settings first.',
          timestamp: new Date(),
        }]);
        onOpenSettings?.();
        return;
      }

      const desktopControlRequirement = inferDesktopControlRequirement(prompt);
      if (desktopControlRequirement) {
        const desktopControlReady = await ensureDesktopControlReady(desktopControlRequirement);
        if (!desktopControlReady) {
          setIsLoading(false);
          return;
        }
      }

      // Cancel any existing task before starting a new one
      if (currentTaskId) {
        try {
          isCancellingRef.current = true;
          await accomplish.cancelTask(currentTaskId);
        } catch {
          // Ignore errors when cancelling - task may already be completed
        } finally {
          isCancellingRef.current = false;
        }
      }

      // Start a new task (don't auto-resume old sessions)
      const nextTaskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      currentTaskIdRef.current = nextTaskId;
      const task = await accomplish.startTask({
        prompt,
        taskId: nextTaskId,
      });
      currentTaskIdRef.current = task.id;
      setCurrentTaskId(task.id);
      // Clear sessionId to avoid auto-resuming in next message
      setSessionId(null);
      setSelectedTaskId(task.id);

      void refreshTaskHistory();
    } catch (error) {
      currentTaskIdRef.current = null;
      setIsLoading(false);
      setMessages(prev => [...prev, {
        id: `error-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to send message'}`,
        timestamp: new Date(),
      }]);
    }
  }, [
    input,
    isLoading,
    currentTaskId,
    accomplish,
    onOpenSettings,
    ensureDesktopControlReady,
    refreshTaskHistory,
  ]);

  // Quick action: capture screen
  const captureScreen = useCallback(async () => {
    if (isLoading) return;
    setShowHistoryPanel(false);

    const desktopControlReady = await ensureDesktopControlReady(SCREEN_CAPTURE_REQUIREMENT);
    if (!desktopControlReady) {
      return;
    }

    const prompt = "Take a screenshot and describe what you see on my screen.";

    const userMessage: Message = {
      id: `user-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      role: 'user',
      content: prompt,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const hasKey = await accomplish.hasAnyApiKey();
      if (!hasKey) {
        setIsLoading(false);
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          role: 'assistant',
          content: 'Please add your API key in Settings first.',
          timestamp: new Date(),
        }]);
        onOpenSettings?.();
        return;
      }

      if (currentTaskId) {
        try {
          await accomplish.cancelTask(currentTaskId);
        } catch {
          // Ignore errors when cancelling
        }
      }

      // Start a new task (don't auto-resume old sessions)
      const nextTaskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      currentTaskIdRef.current = nextTaskId;
      const task = await accomplish.startTask({
        prompt,
        taskId: nextTaskId,
      });
      currentTaskIdRef.current = task.id;
      setCurrentTaskId(task.id);
      // Clear sessionId to avoid auto-resuming in next message
      setSessionId(null);
      setSelectedTaskId(task.id);

      void refreshTaskHistory();
    } catch (error) {
      currentTaskIdRef.current = null;
      setIsLoading(false);
      setMessages(prev => [...prev, {
        id: `error-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to capture screen'}`,
        timestamp: new Date(),
      }]);
    }
  }, [isLoading, accomplish, currentTaskId, onOpenSettings, ensureDesktopControlReady, refreshTaskHistory]);

  const recheckDesktopControl = useCallback(() => {
    void checkDesktopControl({
      revealIfBlocked: true,
      forceRefresh: true,
    });
  }, [checkDesktopControl]);

  const shouldShowDiagnostics =
    showDiagnosticsPanel &&
    (desktopControlStatus?.status !== 'ready' ||
      Boolean(desktopControlError) ||
      isCheckingDesktopControl);

  // Select a previous chat by task ID
  const handleSelectTask = useCallback(
    async (taskId: string) => {
      setSelectedTaskId(taskId);
      selectedTaskIdRef.current = taskId;
      isLoadingRef.current = false;
      setIsLoading(false);
      setShowHistoryPanel(false);

      try {
        const task = await accomplish.getTask(taskId);
        if (!task) return;

        if (task.messages && task.messages.length > 0) {
          const loadedMessages: Message[] = task.messages.map((msg) => ({
            id: msg.id,
            role: msg.type as 'user' | 'assistant' | 'tool',
            content: msg.content,
            timestamp: new Date(msg.timestamp),
            attachments: msg.attachments
              ?.filter((a) => a.type === 'screenshot')
              .map((a) => ({
                type: 'screenshot' as const,
                data: a.data,
              })),
          }));

          setMessages(loadedMessages);
        } else {
          setMessages([]);
        }

        setCurrentTaskId(task.id);
        currentTaskIdRef.current = task.id;

        const session = task.sessionId || task.result?.sessionId || null;
        if (session) {
          sessionIdRef.current = session;
          setSessionId(session);
        } else {
          sessionIdRef.current = null;
          setSessionId(null);
        }
      } catch (error) {
        console.error('[FloatingChat] Failed to load task for history selection:', error);
      }
    },
    [accomplish]
  );

  // Start a brand new chat without any previous context
  const handleNewChat = useCallback(async () => {
    if (currentTaskIdRef.current) {
      try {
        await accomplish.cancelTask(currentTaskIdRef.current);
      } catch {
        // Ignore if task already completed/cancelled
      }
    }

    setMessages([]);
    setInput('');
    isLoadingRef.current = false;
    setIsLoading(false);
    setCurrentTaskId(null);
    currentTaskIdRef.current = null;
    setSessionId(null);
    sessionIdRef.current = null;
    setSelectedTaskId(null);
    selectedTaskIdRef.current = null;
    setShowHistoryPanel(false);
  }, [accomplish]);

  const headerStatus = isLoading
    ? 'Thinking...'
    : shouldShowDiagnostics
      ? 'Desktop control setup needed'
      : 'Ready to help';

  // Handle key press
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const collapseToIcon = useCallback(async () => {
    try {
      await accomplish.collapseToIconWindow?.();
    } catch (error) {
      console.warn('[FloatingChat] Failed to collapse window to icon:', error);
    } finally {
      setIsMinimized(true);
    }
  }, [accomplish]);

  const expandFromIcon = useCallback(async () => {
    try {
      await accomplish.expandFromIconWindow?.();
    } catch (error) {
      console.warn('[FloatingChat] Failed to expand window from icon:', error);
    } finally {
      setIsMinimized(false);
    }
  }, [accomplish]);

  // Minimized view
  if (isMinimized) {
    return (
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="fixed bottom-4 right-4 z-50"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void expandFromIcon()}
          className="h-12 w-12 rounded-none bg-transparent p-0 hover:bg-transparent"
          title="Open Screen Agent"
          aria-label="Open Screen Agent"
        >
          <svg
            viewBox="0 0 64 64"
            className="h-11 w-11 drop-shadow-sm"
            aria-hidden="true"
          >
            <path
              d="M12 10C7.6 10 4 13.6 4 18v20c0 4.4 3.6 8 8 8h26l14 12-4-12h4c4.4 0 8-3.6 8-8V18c0-4.4-3.6-8-8-8H12z"
              fill="#2f7d32"
            />
            <circle cx="22" cy="28" r="4" fill="#ffffff" />
            <circle cx="32" cy="28" r="4" fill="#ffffff" />
            <circle cx="42" cy="28" r="4" fill="#ffffff" />
          </svg>
        </Button>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className={cn(
        'fixed bottom-4 right-4 z-50 max-w-[calc(100vw-2rem)]',
        showHistoryPanel ? 'w-[580px]' : 'w-[420px]'
      )}
    >
      <Card className="flex flex-col h-[600px] shadow-2xl border-border/50 overflow-hidden bg-background/95 backdrop-blur-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Screen Agent</h2>
              <p className="text-xs text-muted-foreground">
                {headerStatus}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setShowHistoryPanel((v) => !v)}
              title="Previous chats"
            >
              <History className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => void handleNewChat()}
              title="New chat"
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onOpenSettings}
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => void collapseToIcon()}
              title="Close to chat bubble"
              aria-label="Close to chat bubble"
            >
              <Minimize2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          <AnimatePresence initial={false}>
            {showHistoryPanel && (
              <motion.div
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                className="w-44 border-r border-border bg-muted/20 p-3 flex flex-col"
              >
                <Button
                  size="sm"
                  className="w-full justify-start gap-2 mb-3"
                  onClick={() => void handleNewChat()}
                >
                  <Plus className="h-4 w-4" />
                  New chat
                </Button>

                <p className="text-xs font-medium text-foreground mb-2">Past chats</p>
                <div className="flex-1 overflow-y-auto space-y-1">
                  {taskHistory.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      No previous chats yet.
                    </p>
                  ) : (
                    taskHistory
                      .slice()
                      .reverse()
                      .map((task) => {
                        const label = task.summary || task.prompt || 'Untitled chat';
                        const created = task.createdAt
                          ? new Date(task.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '';

                        return (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => void handleSelectTask(task.id)}
                            className={cn(
                              'w-full text-left px-2 py-1.5 rounded-md text-[11px] flex items-center justify-between gap-2 hover:bg-muted',
                              selectedTaskId === task.id && 'bg-primary/10 text-primary'
                            )}
                          >
                            <span className="truncate flex-1">{label}</span>
                            {created && (
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {created}
                              </span>
                            )}
                          </button>
                        );
                      })
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex flex-1 flex-col min-w-0">
            <AnimatePresence initial={false}>
              {shouldShowDiagnostics && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className="border-b border-border/70 p-3"
                >
                  <DiagnosticsPanel
                    status={desktopControlStatus}
                    isChecking={isCheckingDesktopControl}
                    errorMessage={desktopControlError}
                    onRecheck={recheckDesktopControl}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {displayMessages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6">
                  <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <Bot className="h-8 w-8 text-primary" />
                  </div>
                  <h3 className="text-lg font-medium text-foreground mb-2">
                    Hi! I can see your screen.
                  </h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Ask me anything about what's on your screen, or let me help you navigate any app.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={captureScreen}
                      className="gap-1.5"
                    >
                      <Camera className="h-3.5 w-3.5" />
                      What's on my screen?
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {displayMessages.map((message) => (
                    <MessageBubble key={message.id} message={message} />
                  ))}
                  {isLoading && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-sm">Thinking...</span>
                    </div>
                  )}
                </>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="p-4 border-t border-border bg-muted/20">
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={captureScreen}
                  disabled={isLoading}
                  title="Capture screen"
                >
                  <Camera className="h-4 w-4" />
                </Button>
                <Input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask me anything..."
                  disabled={isLoading}
                  className="flex-1"
                />
                <Button
                  onClick={sendMessage}
                  disabled={!input.trim() || isLoading}
                  size="icon"
                  className="shrink-0"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}

// Message bubble component
function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
    >
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2.5',
          isUser
            ? 'bg-primary text-primary-foreground'
            : isTool
              ? 'bg-muted/50 border border-border'
              : 'bg-card border border-border'
        )}
      >
        {/* Role indicator for non-user messages */}
        {!isUser && (
          <div className="flex items-center gap-1.5 mb-1.5">
            {isTool ? (
              <ImageIcon className="h-3 w-3 text-muted-foreground" />
            ) : (
              <Bot className="h-3 w-3 text-primary" />
            )}
            <span className="text-xs text-muted-foreground">
              {isTool ? 'Screenshot' : 'Agent'}
            </span>
          </div>
        )}

        {/* Message content */}
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="text-sm prose prose-sm max-w-none prose-p:my-1 prose-headings:text-foreground prose-p:text-foreground">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}

        {/* Screenshots */}
        {message.attachments?.map((attachment, i) => (
          <div key={i} className="mt-2">
            <img
              src={attachment.data}
              alt="Screenshot"
              className="rounded-lg max-w-full max-h-64 object-contain border border-border"
            />
          </div>
        ))}

        {/* Timestamp */}
        <p
          className={cn(
            'text-xs mt-1.5',
            isUser ? 'text-primary-foreground/70' : 'text-muted-foreground'
          )}
        >
          {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    </motion.div>
  );
}

export default FloatingChat;
