/**
 * ScreenViewer Component
 *
 * Provides live screen capture and display functionality.
 * Uses Electron's desktopCapturer API to stream the user's screen
 * and displays it in real-time using a video element.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '../ui/button';
import { Monitor, MonitorOff, RefreshCw } from 'lucide-react';

interface ScreenSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  displayId: string;
  appIconDataUrl?: string;
}

interface ScreenViewerProps {
  className?: string;
  autoStart?: boolean;
  showControls?: boolean;
}

export function ScreenViewer({
  className = '',
  autoStart = false,
  showControls = true,
}: ScreenViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<ScreenSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const hasAutoStartedRef = useRef(false);

  // Fetch available screen sources
  const fetchSources = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      // We rely on getDisplayMedia for actual source selection.
      // Keep a single virtual source entry so the UI can stay enabled.
      const screenSources: ScreenSource[] = [
        {
          id: 'display-media',
          name: 'Screen',
          thumbnailDataUrl: '',
          displayId: 'default',
        },
      ];
      setSources(screenSources);

      // Auto-select first source if none selected
      if (screenSources.length > 0 && !selectedSourceId) {
        setSelectedSourceId(screenSources[0].id);
      }
    } catch (err) {
      console.error('Failed to fetch screen sources:', err);
      setError('Failed to get screen sources. Screen sharing may not be supported.');
    } finally {
      setIsLoading(false);
    }
  }, [selectedSourceId]);

  // Start screen capture
  const startCapture = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      // Stop any existing stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      // Use getDisplayMedia which works with Electron's setDisplayMediaRequestHandler
      // This automatically handles the screen selection
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: 30, max: 60 },
        },
        audio: false,
      });

      streamRef.current = stream;

      // Handle stream ending (user stops sharing)
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        setIsStreaming(false);
        streamRef.current = null;
        if (videoRef.current) {
          videoRef.current.srcObject = null;
        }
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setIsStreaming(true);
    } catch (err) {
      console.error('Failed to start screen capture:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      if (errorMessage.includes('Permission denied') || errorMessage.includes('NotAllowedError')) {
        setError('Screen capture permission denied. Please grant access in System Preferences.');
      } else {
        setError('Failed to start screen capture. Please try again.');
      }
      setIsStreaming(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Stop screen capture
  const stopCapture = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsStreaming(false);
  }, []);

  // Toggle capture
  const toggleCapture = useCallback(async () => {
    if (isStreaming) {
      stopCapture();
    } else {
      await startCapture();
    }
  }, [isStreaming, startCapture, stopCapture]);

  // Auto-start if configured
  useEffect(() => {
    if (autoStart && !hasAutoStartedRef.current && !isStreaming) {
      hasAutoStartedRef.current = true;
      void startCapture();
    }

    return () => {
      stopCapture();
    };
  }, [autoStart, isStreaming, startCapture, stopCapture]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCapture();
    };
  }, [stopCapture]);

  // Initial fetch of sources
  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  return (
    <div className={`relative rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden ${className}`}>
      {/* Header */}
      {showControls && (
        <div className="absolute top-2 left-2 right-2 z-10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                isStreaming ? 'bg-green-500 animate-pulse' : 'bg-zinc-600'
              }`}
            />
            <span className="text-xs text-zinc-400">
              {isStreaming ? 'Live' : 'Screen Capture'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchSources}
              disabled={isLoading}
              className="h-6 w-6 p-0 hover:bg-zinc-800"
              title="Refresh sources"
            >
              <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleCapture}
              disabled={isLoading || (!selectedSourceId && sources.length === 0)}
              className="h-6 w-6 p-0 hover:bg-zinc-800"
              title={isStreaming ? 'Stop capture' : 'Start capture'}
            >
              {isStreaming ? (
                <MonitorOff className="h-3 w-3 text-red-500" />
              ) : (
                <Monitor className="h-3 w-3" />
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Video element for screen capture */}
      <video
        ref={videoRef}
        className="w-full h-full object-contain bg-black"
        autoPlay
        playsInline
        muted
        style={{ minHeight: '200px' }}
      />

      {/* Placeholder when not streaming */}
      {!isStreaming && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/90">
          <Monitor className="h-12 w-12 text-zinc-600 mb-2" />
          <p className="text-sm text-zinc-500 text-center px-4">
            {isLoading
              ? 'Loading...'
              : sources.length === 0
              ? 'No screens available'
              : 'Click to start screen capture'}
          </p>
          {sources.length > 0 && !isLoading && (
            <Button
              onClick={startCapture}
              className="mt-4"
              variant="outline"
              size="sm"
            >
              <Monitor className="h-4 w-4 mr-2" />
              Start Live View
            </Button>
          )}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/90">
          <MonitorOff className="h-12 w-12 text-red-500 mb-2" />
          <p className="text-sm text-red-400 text-center px-4">{error}</p>
          <Button
            onClick={fetchSources}
            className="mt-4"
            variant="outline"
            size="sm"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </div>
      )}

      {/* Source selector (when multiple screens available) */}
      {sources.length > 1 && !isStreaming && showControls && (
        <div className="absolute bottom-2 left-2 right-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {sources.map((source) => (
              <button
                key={source.id}
                onClick={() => setSelectedSourceId(source.id)}
                className={`flex-shrink-0 rounded border ${
                  selectedSourceId === source.id
                    ? 'border-blue-500 ring-1 ring-blue-500'
                    : 'border-zinc-700 hover:border-zinc-600'
                } overflow-hidden bg-zinc-800`}
              >
                <img
                  src={source.thumbnailDataUrl}
                  alt={source.name}
                  className="w-20 h-12 object-cover"
                />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ScreenViewer;
