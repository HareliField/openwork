'use client';

import { useEffect, useState } from 'react';
import { isRunningInElectron, getAccomplish } from './lib/accomplish';
import FloatingChat from './components/FloatingChat';
import SettingsDialog from './components/layout/SettingsDialog';
import { Loader2, AlertTriangle } from 'lucide-react';

type AppStatus = 'loading' | 'ready' | 'error';

export default function App() {
  const [status, setStatus] = useState<AppStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    const checkStatus = async () => {
      // Check if running in Electron
      if (!isRunningInElectron()) {
        setErrorMessage('This application must be run inside the Screen Agent desktop app.');
        setStatus('error');
        return;
      }

      try {
        const accomplish = getAccomplish();
        // Mark onboarding as complete (no welcome screen needed)
        await accomplish.setOnboardingComplete(true);
        
        // Check if user has API key, if not show settings
        const hasKey = await accomplish.hasAnyApiKey();
        if (!hasKey) {
          setShowSettings(true);
        }
        
        setStatus('ready');
      } catch (error) {
        console.error('Failed to initialize app:', error);
        // Still allow app to run even if setting fails
        setStatus('ready');
      }
    };

    checkStatus();
  }, []);

  // Loading state
  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Error state
  if (status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-8">
        <div className="max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>
          </div>
          <h1 className="mb-2 text-xl font-semibold text-foreground">Unable to Start</h1>
          <p className="text-muted-foreground">{errorMessage}</p>
        </div>
      </div>
    );
  }

  // Ready - render the floating chat
  return (
    <div className="min-h-screen bg-transparent">
      {/* Settings dialog */}
      <SettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        onApiKeySaved={() => setShowSettings(false)}
      />
      
      {/* Floating chat interface */}
      <FloatingChat onOpenSettings={() => setShowSettings(true)} />
    </div>
  );
}
