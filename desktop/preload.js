// The Gemini key window (key.html): the only calls it can make to the app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('geminiKey', {
  info: () => ipcRenderer.invoke('gemini-key:info'),
  save: (key) => ipcRenderer.invoke('gemini-key:save', key),
  remove: () => ipcRenderer.invoke('gemini-key:remove'),
  close: () => ipcRenderer.send('gemini-key:close'),
  openStudio: () => ipcRenderer.send('gemini-key:studio'),
});
