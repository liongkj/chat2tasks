import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export function installTauriBridge() {
  if (!window.chat2tasksTauri || window.chat2tasksTauri.demo) return;
  window.chat2tasksDesktop = {
    chooseImport: () => invoke<boolean>('choose_import'),
    importWorkspace: (passphrase) =>
      invoke<{ ok: boolean; error?: string }>('import_workspace', { passphrase }),
    openExternal: (url) => invoke<void>('open_external', { url }),
    onStartupProgress: () => () => undefined,
    onOpenSettings: (callback) => {
      let cancelled = false;
      let unlisten: (() => void) | undefined;
      void listen('open-settings', callback).then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else unlisten = unsubscribe;
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    },
  };
}
