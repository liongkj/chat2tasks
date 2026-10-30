export {};
declare global {
  interface Window {
    chat2tasksDesktop?: {
      chooseImport(): Promise<boolean>;
      importWorkspace(passphrase: string): Promise<{ ok: boolean; error?: string }>;
      openExternal(url: string): Promise<void>;
    };
  }
}
