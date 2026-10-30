const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chat2tasksDesktop', {
  chooseImport: () => ipcRenderer.invoke('workspace:choose-import'),
  importWorkspace: (passphrase) => ipcRenderer.invoke('workspace:import', passphrase),
  openExternal: (url) => ipcRenderer.invoke('auth:open', url),
  onStartupProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('startup:progress', listener);
    return () => ipcRenderer.removeListener('startup:progress', listener);
  },
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('navigation:settings', listener);
    ipcRenderer.send('navigation:ready', true);
    return () => {
      ipcRenderer.removeListener('navigation:settings', listener);
      ipcRenderer.send('navigation:ready', false);
    };
  },
});
