import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  selectFile: (options?: object) => ipcRenderer.invoke('dialog:selectFile', options),
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  showSaveDialog: (options: object) => ipcRenderer.invoke('dialog:showSave', options),
  getApiBase: () => 'http://localhost:8600',
  // Quit the whole app: closes the window AND (via before-quit) kills the
  // backend process. Used by the Settings "Shutdown" button in desktop mode.
  quitApp: () => ipcRenderer.invoke('app:quit'),
})
