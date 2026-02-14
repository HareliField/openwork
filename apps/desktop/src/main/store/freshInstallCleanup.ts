import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { clearAppSettings, clearScreenAgentLifecycleState } from './appSettings';
import { clearSecureStorage } from './secureStorage';

/**
 * Fresh Install Cleanup
 *
 * Detects when the app has been reinstalled (e.g., from a new DMG) and clears
 * old user data to ensure a clean first-run experience.
 *
 * Detection strategy:
 * - Store the app bundle's modification timestamp
 * - On startup, compare current bundle mtime with stored value
 * - If different (or no stored value exists for a packaged app with existing data),
 *   it indicates a reinstall → clear old data
 */

interface InstallMarker {
  /** App bundle modification time (ISO string) */
  bundleMtime: string;
  /** App version at install time */
  version: string;
  /** Timestamp when marker was created */
  markerCreated: string;
}

function logFreshInstallLifecycle(event: string, details: Record<string, unknown> = {}): void {
  console.log(
    '[FreshInstallLifecycle]',
    JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...details,
    })
  );
}

function logFreshInstallLifecycleError(
  event: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    '[FreshInstallLifecycle]',
    JSON.stringify({
      event,
      level: 'error',
      timestamp: new Date().toISOString(),
      message,
      ...details,
    })
  );
}

function getKnownUserDataDirs(): string[] {
  const appDataPath = app.getPath('appData');
  const candidates = [
    app.getPath('userData'),
    path.join(appDataPath, 'Accomplish'),
    path.join(appDataPath, '@accomplish', 'desktop'),
    path.join(appDataPath, 'ai.accomplish.desktop'),
    path.join(appDataPath, 'com.accomplish.desktop'),
  ];

  return [...new Set(candidates)];
}

/**
 * Get the path to the install marker file
 */
function getMarkerPath(): string {
  return path.join(app.getPath('userData'), '.install-marker.json');
}

/**
 * Get the app bundle's modification time
 * For packaged apps, this is the .app bundle directory
 * For dev mode, returns null (skip cleanup logic)
 */
function getAppBundleMtime(): Date | null {
  if (!app.isPackaged) {
    return null;
  }

  // For macOS .app bundles, the executable is at:
  // /Applications/Accomplish.app/Contents/MacOS/Accomplish
  // We want the .app bundle directory
  const execPath = app.getPath('exe');

  // Find the .app bundle path
  const appBundleMatch = execPath.match(/^(.+\.app)/);
  if (!appBundleMatch) {
    console.log('[FreshInstall] Could not determine app bundle path from:', execPath);
    return null;
  }

  const appBundlePath = appBundleMatch[1];

  try {
    const stats = fs.statSync(appBundlePath);
    return stats.mtime;
  } catch (err) {
    console.error('[FreshInstall] Could not stat app bundle:', err);
    return null;
  }
}

/**
 * Read the stored install marker
 */
function readInstallMarker(): InstallMarker | null {
  const markerPath = getMarkerPath();

  try {
    if (fs.existsSync(markerPath)) {
      const content = fs.readFileSync(markerPath, 'utf-8');
      return JSON.parse(content) as InstallMarker;
    }
  } catch (err) {
    console.error('[FreshInstall] Could not read install marker:', err);
  }

  return null;
}

/**
 * Write the install marker
 */
function writeInstallMarker(marker: InstallMarker): void {
  const markerPath = getMarkerPath();

  try {
    // Ensure userData directory exists
    const userDataPath = app.getPath('userData');
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }

    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    console.log('[FreshInstall] Install marker saved');
  } catch (err) {
    console.error('[FreshInstall] Could not write install marker:', err);
  }
}

/**
 * Check if there's existing user data that would indicate a previous installation
 */
function hasExistingUserData(): boolean {
  const dataDirs = getKnownUserDataDirs();
  const storeFiles = ['app-settings.json'];

  return dataDirs.some((dir) =>
    storeFiles.some((file) => fs.existsSync(path.join(dir, file)))
  );
}

/**
 * Clear all user data from previous installation
 */
function clearPreviousInstallData(): void {
  logFreshInstallLifecycle('cleanup-started');

  // Clear electron-store data using the store APIs
  // This is important because stores are already initialized in memory
  try {
    clearAppSettings();
    if (typeof clearScreenAgentLifecycleState === 'function') {
      clearScreenAgentLifecycleState();
    }
    console.log('[FreshInstall]   - Cleared app settings store');
  } catch (err) {
    logFreshInstallLifecycleError('cleanup-app-settings-failed', err);
  }

  // Also delete any other config files that might exist
  const userDataPath = app.getPath('userData');
  const filesToRemove = ['config.json', '.install-marker.json'];

  for (const file of filesToRemove) {
    const filePath = path.join(userDataPath, file);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[FreshInstall]   - Removed: ${file}`);
      }
    } catch (err) {
      logFreshInstallLifecycleError('cleanup-file-remove-failed', err, { filePath });
    }
  }

  // Remove legacy data files from known previous locations
  const legacyDirs = getKnownUserDataDirs().filter((dir) => dir !== userDataPath);
  const legacyFiles = ['app-settings.json', 'config.json', '.install-marker.json'];
  for (const dir of legacyDirs) {
    for (const file of legacyFiles) {
      const filePath = path.join(dir, file);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`[FreshInstall]   - Removed legacy ${file} from ${dir}`);
        }
      } catch (err) {
        logFreshInstallLifecycleError('cleanup-legacy-file-remove-failed', err, { filePath });
      }
    }
  }

  // Clear secure storage (API keys stored via electron-store + safeStorage)
  try {
    clearSecureStorage();
    console.log('[FreshInstall]   - Cleared secure storage');
  } catch (err) {
    logFreshInstallLifecycleError('cleanup-secure-storage-failed', err);
  }

  logFreshInstallLifecycle('cleanup-completed');
}

/**
 * Check if this is a fresh install after a previous installation and perform cleanup
 *
 * Call this early in the app startup, before any stores are initialized.
 * Returns true if cleanup was performed.
 */
export async function checkAndCleanupFreshInstall(): Promise<boolean> {
  // Skip in development mode
  if (!app.isPackaged) {
    logFreshInstallLifecycle('check-skipped-dev-mode');
    return false;
  }

  const bundleMtime = getAppBundleMtime();
  if (!bundleMtime) {
    logFreshInstallLifecycle('check-skipped-no-bundle-mtime');
    return false;
  }

  const currentMtimeStr = bundleMtime.toISOString();
  const currentVersion = app.getVersion();
  const existingMarker = readInstallMarker();

  // Case 1: No marker exists
  if (!existingMarker) {
    // Check if there's existing user data (from a previous install)
    const hadExistingData = hasExistingUserData();
    if (hadExistingData) {
      logFreshInstallLifecycle('reinstall-detected-no-marker');
      clearPreviousInstallData();
    } else {
      logFreshInstallLifecycle('first-install-detected');
    }

    // Create the install marker
    writeInstallMarker({
      bundleMtime: currentMtimeStr,
      version: currentVersion,
      markerCreated: new Date().toISOString(),
    });

    return hadExistingData;
  }

  // Case 2: Marker exists, check if bundle has changed
  if (existingMarker.bundleMtime !== currentMtimeStr) {
    logFreshInstallLifecycle('bundle-change-detected', {
      previousBundleMtime: existingMarker.bundleMtime,
      currentBundleMtime: currentMtimeStr,
    });

    // Clear old data
    clearPreviousInstallData();

    // Update the marker
    writeInstallMarker({
      bundleMtime: currentMtimeStr,
      version: currentVersion,
      markerCreated: new Date().toISOString(),
    });

    return true;
  }

  // Case 3: Same installation, no cleanup needed
  logFreshInstallLifecycle('same-installation-no-cleanup');
  return false;
}
