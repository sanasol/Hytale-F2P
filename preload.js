const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launchGame: (playerName) => ipcRenderer.invoke('launch-game', playerName),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  saveUsername: (username) => ipcRenderer.invoke('save-username', username),
  loadUsername: () => ipcRenderer.invoke('load-username'),
  onProgressUpdate: (callback) => {
    ipcRenderer.on('progress-update', (event, data) => callback(data));
  }
});
