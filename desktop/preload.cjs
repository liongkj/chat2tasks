const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chat2tasksDesktop', {
  chooseImport: () => ipcRenderer.invoke('workspace:choose-import'),
  importWorkspace: (passphrase) => ipcRenderer.invoke('workspace:import', passphrase),
  openExternal: (url) => ipcRenderer.invoke('auth:open', url),
});
