import { useCallback, useEffect, useRef, useState } from 'react';

interface UseSpeechDictationOptions {
  value: string;
  onChange: (next: string) => void;
  lang?: string;
  onError?: (message: string) => void;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

export const DICTATION_FALLBACK_HINT =
  'Fallback: press Fn twice in the input field to use macOS Dictation.';

function getErrorName(value: unknown): string {
  if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
    return value.name;
  }

  return '';
}

function getErrorMessage(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {
    return value.message;
  }

  return '';
}

function shouldIgnoreStartError(value: unknown): boolean {
  const name = getErrorName(value);
  const message = getErrorMessage(value).toLowerCase();

  if (name === 'InvalidStateError' || message.includes('already started')) {
    return true;
  }

  return false;
}

function getRecognitionErrorMessage(error: string): string {
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    return 'Microphone access is blocked. Enable Openwork in System Settings > Privacy & Security > Microphone, then try again.';
  }

  if (error === 'network') {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return 'Dictation could not start because your device appears offline. Reconnect to the internet and try again.';
    }

    return 'Dictation could not reach the speech service (network). Check internet access in this app and temporarily disable VPN/proxy/firewall, then try again.';
  }

  return `Dictation failed (${error}). Please try again.`;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function joinTranscription(base: string, transcript: string): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) {
    return base;
  }

  if (!base.trim()) {
    return trimmedTranscript;
  }

  return /[\s\n]$/.test(base)
    ? `${base}${trimmedTranscript}`
    : `${base} ${trimmedTranscript}`;
}

export function useSpeechDictation({
  value,
  onChange,
  lang,
  onError,
}: UseSpeechDictationOptions) {
  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const isListeningRef = useRef(false);
  const currentValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  const baseTextRef = useRef('');
  const finalTranscriptRef = useRef('');

  useEffect(() => {
    currentValueRef.current = value;
  }, [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const speechRecognitionImpl = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!speechRecognitionImpl) {
      setIsSupported(false);
      return;
    }

    const recognition = new speechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang ?? navigator.language ?? 'en-US';

    recognition.onstart = () => {
      isListeningRef.current = true;
      setIsListening(true);
    };

    recognition.onresult = (event) => {
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';

        if (result.isFinal) {
          finalTranscriptRef.current += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      const combinedTranscript = `${finalTranscriptRef.current} ${interimTranscript}`.trim();
      onChangeRef.current(joinTranscription(baseTextRef.current, combinedTranscript));
    };

    recognition.onerror = (event) => {
      if (event.error === 'aborted') {
        return;
      }

      onErrorRef.current?.(getRecognitionErrorMessage(event.error));
    };

    recognition.onend = () => {
      isListeningRef.current = false;
      setIsListening(false);

      const finalTranscript = finalTranscriptRef.current.trim();
      if (finalTranscript) {
        onChangeRef.current(joinTranscription(baseTextRef.current, finalTranscript));
      }

      finalTranscriptRef.current = '';
    };

    recognitionRef.current = recognition;
    setIsSupported(true);

    return () => {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;

      if (isListeningRef.current) {
        recognition.abort();
      }

      recognitionRef.current = null;
      isListeningRef.current = false;
    };
  }, [lang]);

  const startDictation = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || isListeningRef.current) {
      return;
    }

    baseTextRef.current = currentValueRef.current;
    finalTranscriptRef.current = '';

    try {
      recognition.start();
    } catch (error) {
      if (shouldIgnoreStartError(error)) {
        // Ignore repeated start errors from the underlying recognition engine.
        return;
      }

      const detail = getErrorMessage(error);
      onErrorRef.current?.(
        detail
          ? `Unable to start dictation: ${detail}`
          : 'Unable to start dictation. Please check microphone permissions and try again.'
      );
    }
  }, []);

  const stopDictation = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || !isListeningRef.current) {
      return;
    }

    recognition.stop();
  }, []);

  const toggleDictation = useCallback(() => {
    if (isListeningRef.current) {
      stopDictation();
      return;
    }

    startDictation();
  }, [startDictation, stopDictation]);

  return {
    isSupported,
    isListening,
    startDictation,
    stopDictation,
    toggleDictation,
  };
}
