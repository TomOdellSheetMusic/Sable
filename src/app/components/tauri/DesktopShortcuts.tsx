import { useEffect } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { exit } from '@tauri-apps/plugin-process';
import { useStore } from 'jotai';
import { useOpenSettings } from '$features/settings';
import { createLogger } from '$utils/debug';
import { callEmbedAtom } from '$state/callEmbed';
import { onCallToggleDeafen, onCallToggleMic, onOpenSettings } from '$generated/tauri/events';

const log = createLogger('DesktopShortcuts');

// macOS drives these through the native menu (emitting `open-settings`);
// Windows/Linux have no menubar, so they are wired to Ctrl-key shortcuts here.
export function DesktopShortcuts() {
  const openSettings = useOpenSettings();
  const store = useStore();

  useEffect(() => {
    if (!isTauri()) return undefined;
    const os = osType();
    if (os !== 'windows' && os !== 'linux' && os !== 'macos') return undefined;

    const cleanups: Array<() => void> = [];

    const unlistenSettings = onOpenSettings(() => openSettings());
    unlistenSettings.catch((error) => log.warn('Failed to listen for open-settings:', error));
    unlistenSettings.then((remove) => cleanups.push(remove));

    const toggleMic = () => {
      const embed = store.get(callEmbedAtom);
      if (!embed) {
        log.warn('Global mute-microphone shortcut pressed but no active call embed');
        return;
      }
      embed.control.toggleMicrophone();
    };

    const toggleDeafen = () => {
      const embed = store.get(callEmbedAtom);
      if (!embed) {
        log.warn('Global deafen shortcut pressed but no active call embed');
        return;
      }
      embed.control.toggleSound();
    };

    const unlistenMic = onCallToggleMic(toggleMic);
    unlistenMic.catch((error) => log.warn('Failed to listen for call-toggle-mic:', error));
    unlistenMic.then((remove) => cleanups.push(remove));

    const unlistenDeafen = onCallToggleDeafen(toggleDeafen);
    unlistenDeafen.catch((error) => log.warn('Failed to listen for call-toggle-deafen:', error));
    unlistenDeafen.then((remove) => cleanups.push(remove));

    if (os !== 'macos') {
      const onKeyDown = (event: KeyboardEvent) => {
        if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        const key = event.key.toLowerCase();
        if (key === ',') {
          event.preventDefault();
          openSettings();
        } else if (key === 't') {
          event.preventDefault();
        } else if (key === 'w') {
          event.preventDefault();
          getCurrentWindow()
            .close()
            .catch((error) => log.warn('Failed to close window:', error));
        } else if (key === 'q') {
          event.preventDefault();
          exit(0).catch((error) => log.warn('Failed to quit:', error));
        }
      };
      window.addEventListener('keydown', onKeyDown);
      cleanups.push(() => window.removeEventListener('keydown', onKeyDown));
    }

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [openSettings, store]);

  return null;
}
